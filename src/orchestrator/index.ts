/**
 * Orchestrator plugin registry.
 * Initializes the active plugin based on NONNACLAW_ORCHESTRATOR env var.
 */
import { logger } from '../logger.js';
import { DockerPlugin } from './docker-plugin.js';
import { EcsPlugin } from './ecs-plugin.js';
import type { OrchestratorPlugin } from './types.js';

let activePlugin: OrchestratorPlugin | null = null;

/**
 * Initialize the orchestrator plugin.
 * Reads NONNACLAW_ORCHESTRATOR env var (default: 'docker').
 */
export function initPlugin(name?: string): OrchestratorPlugin {
  const pluginName =
    name || process.env.NONNACLAW_ORCHESTRATOR || 'docker';

  switch (pluginName) {
    case 'docker':
      activePlugin = new DockerPlugin();
      break;
    case 'ecs':
      activePlugin = new EcsPlugin();
      break;
    default:
      throw new Error(`Unknown orchestrator plugin: ${pluginName}`);
  }

  logger.info({ plugin: pluginName }, 'Orchestrator plugin initialized');
  return activePlugin;
}

/**
 * Get the active orchestrator plugin.
 * Throws if initPlugin() hasn't been called.
 */
export function getPlugin(): OrchestratorPlugin {
  if (!activePlugin) {
    throw new Error(
      'Orchestrator plugin not initialized. Call initPlugin() first.',
    );
  }
  return activePlugin;
}

export type { OrchestratorPlugin } from './types.js';
export type {
  AgentHandle,
  AgentLaunchRequest,
  AgentOutput,
  IpcTransport,
  MountDeclaration,
  NetworkInfo,
} from './types.js';
