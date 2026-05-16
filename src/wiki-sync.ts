import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from './logger.js';

export interface WikiSyncOptions {
  localPath: string;
  repoUrl: string | undefined;
  branch: string;
  logger: Logger;
}

export interface WikiSync {
  ensureCloned(): Promise<void>;
  pullOnce(): Promise<void>;
  scheduleCron(expr: string): ScheduledTask;
  withReadLock<T>(fn: () => Promise<T>): Promise<T>;
}

export function createWikiSync(opts: WikiSyncOptions): WikiSync {
  const { localPath, repoUrl, branch, logger } = opts;
  let writing = false;
  const readers = new Set<symbol>();
  const writeWaiters: Array<() => void> = [];

  const acquireRead = async (): Promise<symbol> => {
    while (writing) await new Promise((r) => setTimeout(r, 20));
    const token = Symbol();
    readers.add(token);
    return token;
  };

  const releaseRead = (token: symbol) => {
    readers.delete(token);
    if (readers.size === 0 && writeWaiters.length > 0) {
      const next = writeWaiters.shift();
      next?.();
    }
  };

  const acquireWrite = async (): Promise<void> => {
    if (writing) {
      await new Promise<void>((resolve) => writeWaiters.push(resolve));
    }
    while (readers.size > 0) {
      await new Promise<void>((resolve) => writeWaiters.push(resolve));
    }
    writing = true;
  };

  const releaseWrite = () => {
    writing = false;
  };

  const git = (): SimpleGit => simpleGit({ baseDir: localPath });

  const api: WikiSync = {
    async ensureCloned() {
      if (existsSync(join(localPath, '.git'))) {
        logger.info({ localPath }, 'wiki already present (skip clone)');
        return;
      }
      if (!repoUrl) {
        throw new Error(`Wiki dir ${localPath} missing and WIKI_REPO_URL not set`);
      }
      logger.info({ repoUrl, localPath, branch }, 'cloning wiki');
      await simpleGit().clone(repoUrl, localPath, ['--branch', branch]);
    },

    async pullOnce() {
      if (!existsSync(join(localPath, '.git'))) return;
      await acquireWrite();
      try {
        const result = await git().pull(['--ff-only']);
        logger.info({ result }, 'wiki pulled');
      } catch (err) {
        logger.warn({ err }, 'wiki pull failed (keeping previous state)');
      } finally {
        releaseWrite();
      }
    },

    scheduleCron(expr: string): ScheduledTask {
      return cron.schedule(expr, () => {
        void api.pullOnce();
      });
    },

    async withReadLock<T>(fn: () => Promise<T>): Promise<T> {
      const token = await acquireRead();
      try {
        return await fn();
      } finally {
        releaseRead(token);
      }
    },
  };

  return api;
}
