import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock orchestrator — container-runtime.ts now delegates to the plugin
const mockEnsureReady = vi.fn(async () => {});
const mockCleanupOrphans = vi.fn(async () => {});
vi.mock('./orchestrator/index.js', () => ({
  getPlugin: () => ({
    ensureReady: mockEnsureReady,
    cleanupOrphans: mockCleanupOrphans,
  }),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nonnaclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nonnaclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning (deprecated wrapper) ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockEnsureReady.mockResolvedValueOnce(undefined);

    ensureContainerRuntimeRunning();

    expect(mockEnsureReady).toHaveBeenCalledTimes(1);
  });

  it('delegates error handling to plugin', () => {
    mockEnsureReady.mockRejectedValueOnce(
      new Error('Container runtime is required but failed to start'),
    );

    // Deprecated wrapper catches rejections via .catch()
    ensureContainerRuntimeRunning();

    expect(mockEnsureReady).toHaveBeenCalledTimes(1);
  });
});

// --- cleanupOrphans (deprecated wrapper) ---

describe('cleanupOrphans', () => {
  it('delegates to plugin', () => {
    mockCleanupOrphans.mockResolvedValueOnce(undefined);

    cleanupOrphans();

    expect(mockCleanupOrphans).toHaveBeenCalledTimes(1);
  });

  it('handles plugin errors gracefully', () => {
    mockCleanupOrphans.mockRejectedValueOnce(
      new Error('docker not available'),
    );

    cleanupOrphans(); // should not throw

    expect(mockCleanupOrphans).toHaveBeenCalledTimes(1);
  });
});
