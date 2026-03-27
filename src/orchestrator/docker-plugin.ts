/**
 * Docker orchestrator plugin.
 * Spawns agents in local Docker containers with bind-mounted filesystems.
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from '../config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { validateAdditionalMounts } from '../mount-security.js';
import type { RegisteredGroup } from '../types.js';
import { FilesystemIpcTransport } from './docker-ipc.js';
import type {
  AgentHandle,
  AgentLaunchRequest,
  AgentOutput,
  IpcTransport,
  MountDeclaration,
  NetworkInfo,
  OrchestratorPlugin,
} from './types.js';

const CONTAINER_RUNTIME_BIN = 'docker';
const OUTPUT_START_MARKER = '---NONNACLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NONNACLAW_OUTPUT_END---';

export class DockerPlugin implements OrchestratorPlugin {
  readonly name = 'docker';

  private processes = new Map<string, ChildProcess>();
  private ipcTransport = new FilesystemIpcTransport();

  async ensureReady(): Promise<void> {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.debug('Container runtime already running');
    } catch (err) {
      logger.error({ err }, 'Failed to reach container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Docker is installed and running                     ║',
      );
      console.error(
        '║  2. Run: docker info                                           ║',
      );
      console.error(
        '║  3. Restart NonnaClaw                                          ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter name=nonnaclaw- --format '{{.Names}}'`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) {
        try {
          execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
  }

  prepareMounts(group: RegisteredGroup, isMain: boolean): MountDeclaration[] {
    const mounts: MountDeclaration[] = [];
    const projectRoot = process.cwd();
    const groupDir = resolveGroupFolderPath(group.folder);

    if (isMain) {
      // Main gets the project root read-only. Writable paths the agent needs
      // (group folder, IPC, .claude/) are mounted separately below.
      // Read-only prevents the agent from modifying host application code
      // (src/, dist/, package.json, etc.) which would bypass the sandbox
      // entirely on next restart.
      mounts.push({
        hostPath: projectRoot,
        remotePath: '/workspace/project',
        readonly: true,
      });

      // Main also gets its group folder as the working directory
      mounts.push({
        hostPath: groupDir,
        remotePath: '/workspace/group',
        readonly: false,
      });
    } else {
      // Other groups only get their own folder
      mounts.push({
        hostPath: groupDir,
        remotePath: '/workspace/group',
        readonly: false,
      });

      // Global memory directory (read-only for non-main)
      // Only directory mounts are supported, not file mounts
      const globalDir = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDir)) {
        mounts.push({
          hostPath: globalDir,
          remotePath: '/workspace/global',
          readonly: true,
        });
      }
    }

    // Per-group Claude sessions directory (isolated from other groups)
    // Each group gets their own .claude/ to prevent cross-group session access
    const groupSessionsDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
    );
    fs.mkdirSync(groupSessionsDir, { recursive: true });
    const settingsFile = path.join(groupSessionsDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify(
          {
            env: {
              // Enable agent swarms (subagent orchestration)
              // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              // Load CLAUDE.md from additional mounted directories
              // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
              CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
              // Enable Claude's memory feature (persists user preferences between sessions)
              // https://code.claude.com/docs/en/memory#manage-auto-memory
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            },
          },
          null,
          2,
        ) + '\n',
      );
    }

    // Sync skills from container/skills/ into each group's .claude/skills/
    const skillsSrc = path.join(process.cwd(), 'container', 'skills');
    const skillsDst = path.join(groupSessionsDir, 'skills');
    if (fs.existsSync(skillsSrc)) {
      for (const skillDir of fs.readdirSync(skillsSrc)) {
        const srcDir = path.join(skillsSrc, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        const dstDir = path.join(skillsDst, skillDir);
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }
    }
    mounts.push({
      hostPath: groupSessionsDir,
      remotePath: '/home/node/.claude',
      readonly: false,
    });

    // Per-group IPC namespace: each group gets its own IPC directory
    // This prevents cross-group privilege escalation via IPC
    const groupIpcDir = resolveGroupIpcPath(group.folder);
    fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(groupIpcDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
    mounts.push({
      hostPath: groupIpcDir,
      remotePath: '/workspace/ipc',
      readonly: false,
    });

    // Copy agent-runner source into a per-group writable location so agents
    // can customize it (add tools, change behavior) without affecting other
    // groups. Recompiled on container startup via entrypoint.sh.
    const agentRunnerSrc = path.join(
      projectRoot,
      'container',
      'agent-runner',
      'src',
    );
    const groupAgentRunnerDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'agent-runner-src',
    );
    if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
    mounts.push({
      hostPath: groupAgentRunnerDir,
      remotePath: '/app/src',
      readonly: false,
    });

    // Additional mounts validated against external allowlist (tamper-proof from containers)
    if (group.containerConfig?.additionalMounts) {
      const validatedMounts = validateAdditionalMounts(
        group.containerConfig.additionalMounts,
        group.name,
        isMain,
      );
      for (const m of validatedMounts) {
        mounts.push({
          hostPath: m.hostPath,
          remotePath: m.containerPath,
          readonly: m.readonly,
        });
      }
    }

    return mounts;
  }

  async launchAgent(
    request: AgentLaunchRequest,
    mounts: MountDeclaration[],
    onProcess: (handle: AgentHandle) => void,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ): Promise<AgentOutput> {
    const startTime = Date.now();

    const groupDir = resolveGroupFolderPath(request.groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });

    const safeName = request.groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `nonnaclaw-${safeName}-${Date.now()}`;
    const containerArgs = this.buildContainerArgs(mounts, containerName);

    logger.debug(
      {
        group: request.groupFolder,
        containerName,
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.remotePath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    logger.info(
      {
        group: request.groupFolder,
        containerName,
        mountCount: mounts.length,
        isMain: request.isMain,
      },
      'Spawning container agent',
    );

    const logsDir = path.join(groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    return new Promise((resolve) => {
      const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const handle: AgentHandle = {
        id: containerName,
        groupFolder: request.groupFolder,
      };
      this.processes.set(containerName, container);
      onProcess(handle);

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Build the input payload (matching ContainerInput shape for the container agent-runner)
      const containerInput = {
        prompt: request.prompt,
        sessionId: request.sessionId,
        groupFolder: request.groupFolder,
        chatJid: request.chatJid,
        isMain: request.isMain,
        isScheduledTask: request.isScheduledTask,
        assistantName: request.assistantName,
        secrets: request.secrets,
        additionalMcpServers: request.mcpServers,
      };

      // Pass secrets via stdin (never written to disk or mounted as files)
      container.stdin.write(JSON.stringify(containerInput));
      container.stdin.end();

      // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
      let parseBuffer = '';
      let newSessionId: string | undefined;
      let outputChain = Promise.resolve();

      container.stdout.on('data', (data) => {
        const chunk = data.toString();

        // Always accumulate for logging
        if (!stdoutTruncated) {
          const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
          if (chunk.length > remaining) {
            stdout += chunk.slice(0, remaining);
            stdoutTruncated = true;
            logger.warn(
              { group: request.groupFolder, size: stdout.length },
              'Container stdout truncated due to size limit',
            );
          } else {
            stdout += chunk;
          }
        }

        // Stream-parse for output markers
        if (onOutput) {
          parseBuffer += chunk;
          let startIdx: number;
          while (
            (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
          ) {
            const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
            if (endIdx === -1) break; // Incomplete pair, wait for more data

            const jsonStr = parseBuffer
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
            parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

            try {
              const parsed: AgentOutput = JSON.parse(jsonStr);
              if (parsed.newSessionId) {
                newSessionId = parsed.newSessionId;
              }
              hadStreamingOutput = true;
              // Activity detected — reset the hard timeout
              resetTimeout();
              // Call onOutput for all markers (including null results)
              // so idle timers start even for "silent" query completions.
              outputChain = outputChain.then(() => onOutput(parsed));
            } catch (err) {
              logger.warn(
                { group: request.groupFolder, error: err },
                'Failed to parse streamed output chunk',
              );
            }
          }
        }
      });

      container.stderr.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug({ container: request.groupFolder }, line);
        }
        // Don't reset timeout on stderr — SDK writes debug logs continuously.
        // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
        if (stderrTruncated) return;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
          logger.warn(
            { group: request.groupFolder, size: stderr.length },
            'Container stderr truncated due to size limit',
          );
        } else {
          stderr += chunk;
        }
      });

      let timedOut = false;
      let hadStreamingOutput = false;
      const configTimeout =
        this.groupConfigs.get(request.groupFolder)?.containerConfig?.timeout ||
        CONTAINER_TIMEOUT;
      // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
      // graceful _close sentinel has time to trigger before the hard kill fires.
      const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: request.groupFolder, containerName },
          'Container timeout, stopping gracefully',
        );
        exec(
          `${CONTAINER_RUNTIME_BIN} stop ${containerName}`,
          { timeout: 15000 },
          (err) => {
            if (err) {
              logger.warn(
                { group: request.groupFolder, containerName, err },
                'Graceful stop failed, force killing',
              );
              container.kill('SIGKILL');
            }
          },
        );
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      // Reset the timeout whenever there's activity (streaming output)
      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      container.on('close', (code) => {
        clearTimeout(timeout);
        this.processes.delete(containerName);
        const duration = Date.now() - startTime;

        if (timedOut) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const timeoutLog = path.join(logsDir, `container-${ts}.log`);
          fs.writeFileSync(
            timeoutLog,
            [
              `=== Container Run Log (TIMEOUT) ===`,
              `Timestamp: ${new Date().toISOString()}`,
              `Group: ${request.groupFolder}`,
              `Container: ${containerName}`,
              `Duration: ${duration}ms`,
              `Exit Code: ${code}`,
              `Had Streaming Output: ${hadStreamingOutput}`,
            ].join('\n'),
          );

          // Timeout after output = idle cleanup, not failure.
          // The agent already sent its response; this is just the
          // container being reaped after the idle period expired.
          if (hadStreamingOutput) {
            logger.info(
              { group: request.groupFolder, containerName, duration, code },
              'Container timed out after output (idle cleanup)',
            );
            outputChain.then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            });
            return;
          }

          logger.error(
            { group: request.groupFolder, containerName, duration, code },
            'Container timed out with no output',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Container timed out after ${configTimeout}ms`,
          });
          return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `container-${timestamp}.log`);
        const isVerbose =
          process.env.LOG_LEVEL === 'debug' ||
          process.env.LOG_LEVEL === 'trace';

        const logLines = [
          `=== Container Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${request.groupFolder}`,
          `IsMain: ${request.isMain}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Stdout Truncated: ${stdoutTruncated}`,
          `Stderr Truncated: ${stderrTruncated}`,
          ``,
        ];

        const isError = code !== 0;

        if (isVerbose || isError) {
          logLines.push(
            `=== Input ===`,
            JSON.stringify(
              { ...containerInput, secrets: '[REDACTED]' },
              null,
              2,
            ),
            ``,
            `=== Container Args ===`,
            containerArgs.join(' '),
            ``,
            `=== Mounts ===`,
            mounts
              .map(
                (m) =>
                  `${m.hostPath} -> ${m.remotePath}${m.readonly ? ' (ro)' : ''}`,
              )
              .join('\n'),
            ``,
            `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
            stderr,
            ``,
            `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
            stdout,
          );
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${request.prompt.length} chars`,
            `Session ID: ${request.sessionId || 'new'}`,
            ``,
            `=== Mounts ===`,
            mounts
              .map((m) => `${m.remotePath}${m.readonly ? ' (ro)' : ''}`)
              .join('\n'),
            ``,
          );
        }

        fs.writeFileSync(logFile, logLines.join('\n'));
        logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

        if (code !== 0) {
          logger.error(
            {
              group: request.groupFolder,
              code,
              duration,
              stderr,
              stdout,
              logFile,
            },
            'Container exited with error',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          });
          return;
        }

        // Streaming mode: wait for output chain to settle, return completion marker
        if (onOutput) {
          outputChain.then(() => {
            logger.info(
              { group: request.groupFolder, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        // Legacy mode: parse the last output marker pair from accumulated stdout
        try {
          // Extract JSON between sentinel markers for robust parsing
          const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
          const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

          let jsonLine: string;
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonLine = stdout
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
          } else {
            // Fallback: last non-empty line (backwards compatibility)
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }

          const output: AgentOutput = JSON.parse(jsonLine);

          logger.info(
            {
              group: request.groupFolder,
              duration,
              status: output.status,
              hasResult: !!output.result,
            },
            'Container completed',
          );

          resolve(output);
        } catch (err) {
          logger.error(
            {
              group: request.groupFolder,
              stdout,
              stderr,
              error: err,
            },
            'Failed to parse container output',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        this.processes.delete(containerName);
        logger.error(
          { group: request.groupFolder, containerName, error: err },
          'Container spawn error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`,
        });
      });
    });
  }

  async stopAgent(handle: AgentHandle): Promise<void> {
    const proc = this.processes.get(handle.id);
    if (!proc) return;
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} stop ${handle.id}`, {
        stdio: 'pipe',
        timeout: 15000,
      });
    } catch {
      // already stopped or timed out
    }
  }

  async killAgent(handle: AgentHandle): Promise<void> {
    const proc = this.processes.get(handle.id);
    if (!proc) return;
    proc.kill('SIGKILL');
  }

  getNetworkInfo(): NetworkInfo {
    return { hostAddress: 'host.docker.internal' };
  }

  getIpcTransport(): IpcTransport {
    return this.ipcTransport;
  }

  private groupConfigs = new Map<string, RegisteredGroup>();

  /** Register a group's config for later lookup during launchAgent (e.g., timeout). */
  registerGroupConfig(group: RegisteredGroup): void {
    this.groupConfigs.set(group.folder, group);
  }

  private buildContainerArgs(
    mounts: MountDeclaration[],
    containerName: string,
  ): string[] {
    const args: string[] = ['run', '-i', '--rm', '--name', containerName];

    // Pass host timezone so container's local time matches the user's
    args.push('-e', `TZ=${TIMEZONE}`);

    // Allow containers to reach host-side MCP bridges via host.docker.internal
    args.push('--add-host=host.docker.internal:host-gateway');

    // Run as host user so bind-mounted files are accessible.
    // Skip when running as root (uid 0), as the container's node user (uid 1000),
    // or when getuid is unavailable (native Windows without WSL).
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
      args.push('-e', 'HOME=/home/node');
    }

    for (const mount of mounts) {
      if (mount.readonly) {
        args.push('-v', `${mount.hostPath}:${mount.remotePath}:ro`);
      } else {
        args.push('-v', `${mount.hostPath}:${mount.remotePath}`);
      }
    }

    args.push(CONTAINER_IMAGE);

    return args;
  }
}
