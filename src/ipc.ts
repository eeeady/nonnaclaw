import { CronExpressionParser } from 'cron-parser';

import {
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteKvState,
  deleteTask,
  getTaskById,
  setKvState,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { getPlugin } from './orchestrator/index.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata?: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const transport = getPlugin().getIpcTransport();

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    const groupFolders = transport.listGroupFolders();

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;

      // Process messages from this group's IPC directory
      const messageFiles = transport.consumeFiles(sourceGroup, 'messages');
      for (const { filename, data } of messageFiles) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'message' && parsed.chatJid && parsed.text) {
            // Authorization: verify this group can send to this chatJid
            const targetGroup = registeredGroups[parsed.chatJid];
            if (
              isMain ||
              (targetGroup && targetGroup.folder === sourceGroup)
            ) {
              try {
                await deps.sendMessage(parsed.chatJid, parsed.text);
              } catch {
                logger.warn(
                  { chatJid: parsed.chatJid, sourceGroup },
                  'Failed to send IPC message',
                );
              }
              logger.info(
                { chatJid: parsed.chatJid, sourceGroup },
                'IPC message sent',
              );
            } else {
              logger.warn(
                { chatJid: parsed.chatJid, sourceGroup },
                'Unauthorized IPC message attempt blocked',
              );
            }
          }
        } catch (err) {
          logger.error(
            { file: filename, sourceGroup, err },
            'Error processing IPC message',
          );
          transport.moveToError(sourceGroup, `messages/${filename}`, data);
        }
      }

      // Process tasks from this group's IPC directory
      const taskFiles = transport.consumeFiles(sourceGroup, 'tasks');
      for (const { filename, data } of taskFiles) {
        try {
          const parsed = JSON.parse(data);
          // Pass source group identity to processTaskIpc for authorization
          await processTaskIpc(parsed, sourceGroup, isMain, deps);
        } catch (err) {
          logger.error(
            { file: filename, sourceGroup, err },
            'Error processing IPC task',
          );
          transport.moveToError(sourceGroup, `tasks/${filename}`, data);
        }
      }

      // Process state operations from this group's IPC directory
      const stateFiles = transport.consumeFiles(sourceGroup, 'state');
      for (const { filename, data } of stateFiles) {
        try {
          const parsed = JSON.parse(data);
          if (
            parsed.type === 'save_state' &&
            parsed.key &&
            parsed.value != null
          ) {
            setKvState(sourceGroup, parsed.key, parsed.value);
            logger.debug(
              { key: parsed.key, sourceGroup },
              'KV state saved via IPC',
            );
          } else if (parsed.type === 'delete_state' && parsed.key) {
            deleteKvState(sourceGroup, parsed.key);
            logger.debug(
              { key: parsed.key, sourceGroup },
              'KV state deleted via IPC',
            );
          }
        } catch (err) {
          logger.error(
            { file: filename, sourceGroup, err },
            'Error processing IPC state',
          );
          transport.moveToError(sourceGroup, `state/${filename}`, data);
        }
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    authorizedSkills?: RegisteredGroup['authorizedSkills'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        if (deps.syncGroupMetadata) {
          await deps.syncGroupMetadata(true);
        } else {
          logger.debug(
            'No syncGroupMetadata handler (channel managed by skill)',
          );
        }
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          authorizedSkills: data.authorizedSkills,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
