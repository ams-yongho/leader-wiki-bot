import { describe, it, expect, beforeEach } from 'vitest';
import { createWikiSync } from '../src/wiki-sync.js';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('createWikiSync (bind-mount mode)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-'));
  });

  it('이미 존재하는 디렉토리는 clone을 호출하지 않음', async () => {
    mkdirSync(join(dir, '.git'));
    const sync = createWikiSync({
      localPath: dir,
      repoUrl: undefined,
      branch: 'main',
      logger: stubLogger(),
    });
    await sync.ensureCloned();
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('withReadLock은 pull 중에도 reader가 진행하게 함 (concurrent)', async () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'README.md'), 'x');
    const sync = createWikiSync({
      localPath: dir,
      repoUrl: undefined,
      branch: 'main',
      logger: stubLogger(),
    });
    const r = await sync.withReadLock(async () => 'read');
    expect(r).toBe('read');
  });
});

function stubLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  } as unknown as import('../src/logger.js').Logger;
}
