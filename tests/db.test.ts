import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations } from '../src/db.js';

const tmpDirs: string[] = [];
function makeTmp() {
  const d = mkdtempSync(join(tmpdir(), 'qlog-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('db', () => {
  it('빈 DB에 마이그레이션 적용 후 queries 테이블 존재', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'q.db');
    const db = openDb(dbPath);
    runMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queries'")
      .get();
    expect(row).toBeTruthy();
  });

  it('마이그레이션은 멱등 — 두 번 호출해도 에러 없음', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'q.db');
    const db = openDb(dbPath);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const v = (db.pragma('user_version', { simple: true }) as number);
    expect(v).toBe(1);
  });

  it('상위 디렉토리가 없어도 자동 생성', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'nested', 'deep', 'q.db');
    expect(() => openDb(dbPath)).not.toThrow();
  });
});
