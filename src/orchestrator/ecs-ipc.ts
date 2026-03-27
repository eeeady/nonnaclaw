/**
 * SQS/S3-based IPC transport for ECS.
 * Agents communicate via SQS queues (messages) and S3 (snapshots).
 *
 * TODO: Implement when ECS support is needed.
 * - Snapshots: S3 bucket with prefix per group (s3://{bucket}/ipc/{group}/{filename})
 * - Input/close: SQS queue per group (nonnaclaw-ipc-{group})
 * - Polling: SQS ReceiveMessage with long-polling
 * - Error handling: SQS dead-letter queue
 */
import { logger } from '../logger.js';
import type { IpcTransport } from './types.js';

export class SqsIpcTransport implements IpcTransport {
  writeSnapshot(
    _groupFolder: string,
    _filename: string,
    _data: string,
  ): void {
    // TODO: Write to S3: s3://{bucket}/ipc/{groupFolder}/{filename}
    logger.warn('ECS IPC writeSnapshot not yet implemented');
  }

  sendInput(
    _groupFolder: string,
    _payload: { type: string; text?: string },
  ): boolean {
    // TODO: Send to SQS queue: nonnaclaw-input-{groupFolder}
    logger.warn('ECS IPC sendInput not yet implemented');
    return false;
  }

  sendClose(_groupFolder: string): void {
    // TODO: Send close message to SQS queue: nonnaclaw-input-{groupFolder}
    logger.warn('ECS IPC sendClose not yet implemented');
  }

  listGroupFolders(): string[] {
    // TODO: List S3 prefixes under s3://{bucket}/ipc/
    logger.warn('ECS IPC listGroupFolders not yet implemented');
    return [];
  }

  consumeFiles(
    _groupFolder: string,
    _subdir: string,
  ): Array<{ filename: string; data: string }> {
    // TODO: Receive from SQS queue: nonnaclaw-{subdir}-{groupFolder}
    // Delete messages after processing
    logger.warn('ECS IPC consumeFiles not yet implemented');
    return [];
  }

  moveToError(
    _groupFolder: string,
    _filename: string,
    _data: string,
  ): void {
    // TODO: Move to SQS dead-letter queue or S3 error prefix
    logger.warn('ECS IPC moveToError not yet implemented');
  }
}
