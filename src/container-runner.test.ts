import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nonnaclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nonnaclaw-test-data',
  GROUPS_DIR: '/tmp/nonnaclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'test-token' })),
}));

// Mock skill-registry
vi.mock('./skill-registry.js', () => ({
  collectProxiedMcpServers: vi.fn(() => ({})),
}));

// Track mock plugin behavior
const mockLaunchAgent = vi.fn();
const mockPrepareMounts = vi.fn(() => []);
const mockWriteSnapshot = vi.fn();
const mockRegisterGroupConfig = vi.fn();

vi.mock('./orchestrator/index.js', () => ({
  getPlugin: () => ({
    prepareMounts: mockPrepareMounts,
    launchAgent: mockLaunchAgent,
    getIpcTransport: () => ({
      writeSnapshot: mockWriteSnapshot,
    }),
  }),
}));

vi.mock('./orchestrator/docker-plugin.js', () => ({
  DockerPlugin: class {},
}));

import {
  runContainerAgent,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  writeStateSnapshot,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runContainerAgent (facade)', () => {
  it('delegates to plugin.launchAgent', async () => {
    mockLaunchAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-123',
    });

    const result = await runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    expect(mockPrepareMounts).toHaveBeenCalledWith(testGroup, false);
    expect(mockLaunchAgent).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
  });

  it('passes onOutput callback through', async () => {
    const onOutput = vi.fn(async () => {});
    mockLaunchAgent.mockResolvedValueOnce({
      status: 'success',
      result: null,
    });

    await runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // The 4th argument to launchAgent should be the onOutput callback
    expect(mockLaunchAgent.mock.calls[0][3]).toBe(onOutput);
  });

  it('returns error on plugin failure', async () => {
    mockLaunchAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'Container exited with code 1',
    });

    const result = await runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Container exited');
  });
});

describe('writeTasksSnapshot', () => {
  it('writes filtered tasks for non-main group', () => {
    const tasks = [
      { id: '1', groupFolder: 'test-group', prompt: 'a', schedule_type: 'cron', schedule_value: '* * * * *', status: 'active', next_run: null },
      { id: '2', groupFolder: 'other-group', prompt: 'b', schedule_type: 'cron', schedule_value: '* * * * *', status: 'active', next_run: null },
    ];

    writeTasksSnapshot('test-group', false, tasks);

    expect(mockWriteSnapshot).toHaveBeenCalledWith(
      'test-group',
      'current_tasks.json',
      expect.any(String),
    );
    const written = JSON.parse(mockWriteSnapshot.mock.calls[0][2]);
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('1');
  });

  it('writes all tasks for main group', () => {
    const tasks = [
      { id: '1', groupFolder: 'main', prompt: 'a', schedule_type: 'cron', schedule_value: '* * * * *', status: 'active', next_run: null },
      { id: '2', groupFolder: 'other', prompt: 'b', schedule_type: 'cron', schedule_value: '* * * * *', status: 'active', next_run: null },
    ];

    writeTasksSnapshot('main', true, tasks);

    const written = JSON.parse(mockWriteSnapshot.mock.calls[0][2]);
    expect(written).toHaveLength(2);
  });
});

describe('writeGroupsSnapshot', () => {
  it('writes groups for main, empty for non-main', () => {
    const groups = [{ jid: 'a@g.us', name: 'A', lastActivity: '', isRegistered: true }];

    writeGroupsSnapshot('main', true, groups, new Set(['a@g.us']));
    const mainData = JSON.parse(mockWriteSnapshot.mock.calls[0][2]);
    expect(mainData.groups).toHaveLength(1);

    mockWriteSnapshot.mockClear();

    writeGroupsSnapshot('other', false, groups, new Set(['a@g.us']));
    const otherData = JSON.parse(mockWriteSnapshot.mock.calls[0][2]);
    expect(otherData.groups).toHaveLength(0);
  });
});

describe('writeStateSnapshot', () => {
  it('delegates to IPC transport', () => {
    writeStateSnapshot('test-group', { key1: 'val1' });

    expect(mockWriteSnapshot).toHaveBeenCalledWith(
      'test-group',
      'current_state.json',
      expect.any(String),
    );
    const written = JSON.parse(mockWriteSnapshot.mock.calls[0][2]);
    expect(written.key1).toBe('val1');
  });
});
