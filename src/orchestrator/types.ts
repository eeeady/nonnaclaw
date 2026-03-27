/**
 * Orchestrator plugin interfaces.
 * Plugins implement these to support different agent runtimes (Docker, ECS, etc.).
 */
import type { RegisteredGroup } from '../types.js';

/** Opaque handle for a running agent (container name, task ARN, etc.) */
export interface AgentHandle {
  id: string;
  groupFolder: string;
}

/** Result of agent execution */
export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/** What the orchestrator passes to launch an agent */
export interface AgentLaunchRequest {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets: Record<string, string>;
  mcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  >;
}

/** Abstract storage mount — plugins translate to their native format */
export interface MountDeclaration {
  hostPath: string;
  remotePath: string;
  readonly: boolean;
}

/** How agents reach the host (Docker: host.docker.internal, ECS: ALB URL) */
export interface NetworkInfo {
  hostAddress: string;
}

/** Core plugin interface */
export interface OrchestratorPlugin {
  readonly name: string;

  /** Validate that the runtime is available and operational. Throws if not ready. */
  ensureReady(): Promise<void>;

  /** Kill orphaned agents from previous runs. */
  cleanupOrphans(): Promise<void>;

  /** Compute and prepare mount declarations for a group (may create dirs, sync files). */
  prepareMounts(group: RegisteredGroup, isMain: boolean): MountDeclaration[];

  /**
   * Launch an agent and return the result.
   * onProcess is called once the agent handle is available (for tracking).
   * onOutput is called for each streaming result chunk.
   */
  launchAgent(
    request: AgentLaunchRequest,
    mounts: MountDeclaration[],
    onProcess: (handle: AgentHandle) => void,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ): Promise<AgentOutput>;

  /** Gracefully stop a running agent. */
  stopAgent(handle: AgentHandle): Promise<void>;

  /** Force-kill a running agent. */
  killAgent(handle: AgentHandle): Promise<void>;

  /** Get networking info for agent-to-host communication. */
  getNetworkInfo(): NetworkInfo;

  /** Get the IPC transport for this plugin. */
  getIpcTransport(): IpcTransport;
}

/** Abstracts host↔agent message passing */
export interface IpcTransport {
  /** Write a snapshot file the agent can read synchronously. */
  writeSnapshot(groupFolder: string, filename: string, data: string): void;

  /** Send a follow-up input message to a running agent. Returns true if written. */
  sendInput(
    groupFolder: string,
    payload: { type: string; text?: string },
  ): boolean;

  /** Signal an agent to wind down. */
  sendClose(groupFolder: string): void;

  /** List all group folders that have IPC namespaces. */
  listGroupFolders(): string[];

  /** Read and consume pending IPC files from a subdirectory. Returns data and removes source files. */
  consumeFiles(
    groupFolder: string,
    subdir: string,
  ): Array<{ filename: string; data: string }>;

  /** Move a failed IPC file to an error directory for debugging. */
  moveToError(
    groupFolder: string,
    filename: string,
    data: string,
  ): void;
}
