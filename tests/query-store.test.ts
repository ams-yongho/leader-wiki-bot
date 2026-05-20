import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations } from '../src/db.js';
import { createQueryStore, type QueryRecord } from '../src/query-store.js';

const tmpDirs: string[] = [];
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qstore-'));
  tmpDirs.push(dir);
  const db = openDb(join(dir, 'q.db'));
  runMigrations(db);
  return { db, store: createQueryStore(db) };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const baseRecord: QueryRecord = {
  eventId: 'evt-1',
  receivedAt: '2026-05-20T00:00:00.000Z',
  completedAt: '2026-05-20T00:00:02.000Z',
  channel: 'C123',
  threadTs: '1716163200.000100',
  slackUser: 'U999',
  question: '프로젝트 알파 진행 상황은?',
  questionRaw: '<@UBOT> 프로젝트 알파 진행 상황은?',
  priorTurns: 0,
  answer: '진행 중입니다.',
  citations: ['wiki/프로젝트-알파.md'],
  model: 'claude-sonnet-4-6',
  status: 'success',
  errorMessage: null,
};

describe('query-store', () => {
  it('성공 row INSERT 후 SELECT로 확인', () => {
    const { db, store } = makeStore();
    store.recordQuery(baseRecord);
    const row = db.prepare('SELECT * FROM queries WHERE event_id=?').get('evt-1') as Record<string, unknown>;
    expect(row.status).toBe('success');
    expect(row.question).toBe('프로젝트 알파 진행 상황은?');
    expect(JSON.parse(row.citations_json as string)).toEqual(['wiki/프로젝트-알파.md']);
    expect(row.latency_ms).toBe(2000);
  });

  it('citations 빈 배열도 정상 저장', () => {
    const { db, store } = makeStore();
    store.recordQuery({ ...baseRecord, citations: [] });
    const row = db.prepare('SELECT citations_json FROM queries WHERE event_id=?').get('evt-1') as { citations_json: string };
    expect(JSON.parse(row.citations_json)).toEqual([]);
  });

  it('citations null이면 citations_json은 NULL', () => {
    const { db, store } = makeStore();
    store.recordQuery({ ...baseRecord, citations: null });
    const row = db.prepare('SELECT citations_json FROM queries WHERE event_id=?').get('evt-1') as { citations_json: string | null };
    expect(row.citations_json).toBeNull();
  });

  it('동일 event_id 두 번 INSERT 시 UNIQUE constraint 에러를 던지지 않고 무시', () => {
    const { db, store } = makeStore();
    store.recordQuery(baseRecord);
    expect(() => store.recordQuery({ ...baseRecord, question: '다른 질문' })).not.toThrow();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM queries').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('error 상태는 answer NULL, error_message 보존', () => {
    const { db, store } = makeStore();
    store.recordQuery({
      ...baseRecord,
      eventId: 'evt-err',
      answer: null,
      citations: null,
      status: 'error',
      errorMessage: 'rate limited',
    });
    const row = db.prepare('SELECT * FROM queries WHERE event_id=?').get('evt-err') as Record<string, unknown>;
    expect(row.answer).toBeNull();
    expect(row.status).toBe('error');
    expect(row.error_message).toBe('rate limited');
  });
});
