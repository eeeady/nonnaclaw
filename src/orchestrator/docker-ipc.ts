/**
 * Filesystem-based IPC transport for Docker.
 * Agents communicate via JSON files in data/ipc/{group}/ directories.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type { IpcTransport } from './types.js';

export class FilesystemIpcTransport implements IpcTransport {
  private readonly ipcBaseDir: string;

  constructor() {
    this.ipcBaseDir = path.join(DATA_DIR, 'ipc');
    fs.mkdirSync(this.ipcBaseDir, { recursive: true });
  }

  writeSnapshot(groupFolder: string, filename: string, data: string): void {
    const groupIpcDir = resolveGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    const filepath = path.join(groupIpcDir, filename);
    fs.writeFileSync(filepath, data);
  }

  sendInput(
    groupFolder: string,
    payload: { type: string; text?: string },
  ): boolean {
    const inputDir = path.join(
      resolveGroupIpcPath(groupFolder),
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  sendClose(groupFolder: string): void {
    const inputDir = path.join(
      resolveGroupIpcPath(groupFolder),
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  listGroupFolders(): string[] {
    try {
      return fs.readdirSync(this.ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(this.ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return [];
    }
  }

  consumeFiles(
    groupFolder: string,
    subdir: string,
  ): Array<{ filename: string; data: string }> {
    const dir = path.join(this.ipcBaseDir, groupFolder, subdir);
    const results: Array<{ filename: string; data: string }> = [];

    try {
      if (!fs.existsSync(dir)) return results;

      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'));

      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const data = fs.readFileSync(filePath, 'utf-8');
          fs.unlinkSync(filePath);
          results.push({ filename: file, data });
        } catch (err) {
          logger.error(
            { file, groupFolder, subdir, err },
            'Error reading IPC file',
          );
          // Move to error directory
          try {
            this.moveToError(groupFolder, file, '');
          } catch {
            // best effort
          }
        }
      }
    } catch (err) {
      logger.error(
        { err, groupFolder, subdir },
        'Error reading IPC directory',
      );
    }

    return results;
  }

  moveToError(
    groupFolder: string,
    filename: string,
    _data: string,
  ): void {
    const errorDir = path.join(this.ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });

    const sourcePath = path.join(this.ipcBaseDir, groupFolder, filename);
    const destPath = path.join(errorDir, `${groupFolder}-${filename}`);

    try {
      if (fs.existsSync(sourcePath)) {
        fs.renameSync(sourcePath, destPath);
      }
    } catch {
      // best effort
    }
  }
}
