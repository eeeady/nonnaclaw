/**
 * Container Runner facade for NonnaClaw.
 * Delegates to the active orchestrator plugin while preserving the existing API.
 */
import { ChildProcess } from 'child_process';

import { readEnvFile } from './env.js';
import { getPlugin } from './orchestrator/index.js';
import { DockerPlugin } from './orchestrator/docker-plugin.js';
import { collectProxiedMcpServers } from './skill-registry.js';
import type { LoadedSkill, RegisteredGroup } from './types.js';

/** Path to the compiled MCP forwarder inside the container (after tsc) */
const CONTAINER_MCP_FORWARDER_PATH = '/tmp/dist/mcp-forwarder.js';

// Module-level state for loaded skills (set by orchestrator on startup)
let loadedSkills: LoadedSkill[] = [];

export function setLoadedSkills(skills: LoadedSkill[]): void {
  loadedSkills = skills;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  additionalMcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  >;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Read allowed secrets from .env for passing to the agent via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const plugin = getPlugin();

  // Register group config so the plugin can access timeout settings
  if (plugin instanceof DockerPlugin) {
    plugin.registerGroupConfig(group);
  }

  // Prepare mounts via the plugin
  const mounts = plugin.prepareMounts(group, input.isMain);

  // Inject MCP servers for authorized skills (proxied with scoping rules)
  const proxied = collectProxiedMcpServers(
    loadedSkills,
    group,
    CONTAINER_MCP_FORWARDER_PATH,
  );

  const secrets = readSecrets();

  return plugin.launchAgent(
    {
      prompt: input.prompt,
      sessionId: input.sessionId,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      isMain: input.isMain,
      isScheduledTask: input.isScheduledTask,
      assistantName: input.assistantName,
      secrets,
      mcpServers: Object.keys(proxied).length > 0 ? proxied : undefined,
    },
    mounts,
    (handle) => {
      // Bridge AgentHandle back to the ChildProcess-based callback
      // The Docker plugin tracks processes internally; for the legacy API
      // we pass null as the proc since callers only use containerName for display
      onProcess(null as unknown as ChildProcess, handle.id);
    },
    onOutput,
  );
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  getPlugin()
    .getIpcTransport()
    .writeSnapshot(
      groupFolder,
      'current_tasks.json',
      JSON.stringify(filteredTasks, null, 2),
    );
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  getPlugin()
    .getIpcTransport()
    .writeSnapshot(
      groupFolder,
      'available_groups.json',
      JSON.stringify(
        {
          groups: visibleGroups,
          lastSync: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
}

/**
 * Write KV state snapshot for the container to read.
 * The in-container MCP server reads this for synchronous get_state calls.
 */
export function writeStateSnapshot(
  groupFolder: string,
  state: Record<string, string>,
): void {
  getPlugin()
    .getIpcTransport()
    .writeSnapshot(
      groupFolder,
      'current_state.json',
      JSON.stringify(state, null, 2),
    );
}
