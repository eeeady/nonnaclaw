/**
 * @deprecated Use the orchestrator plugin system instead (src/orchestrator/).
 * This file is kept for backwards compatibility with existing imports.
 */
import { getPlugin } from './orchestrator/index.js';

/** @deprecated Use getPlugin().name or reference the plugin directly */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** @deprecated Volume mount args are handled by the plugin's prepareMounts/launchAgent */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** @deprecated Use getPlugin().stopAgent() */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** @deprecated Use getPlugin().ensureReady() */
export function ensureContainerRuntimeRunning(): void {
  // Synchronous wrapper for backwards compat — the plugin is initialized
  // before this is called, so we can call ensureReady synchronously via
  // the plugin's own sync validation path.
  const plugin = getPlugin();
  // ensureReady is async in the interface, but Docker's impl uses execSync
  // so we can safely ignore the promise for backwards compat
  plugin.ensureReady().catch(() => {
    // Error already logged and thrown by the plugin
  });
}

/** @deprecated Use getPlugin().cleanupOrphans() */
export function cleanupOrphans(): void {
  const plugin = getPlugin();
  plugin.cleanupOrphans().catch(() => {
    // Error already logged by the plugin
  });
}
