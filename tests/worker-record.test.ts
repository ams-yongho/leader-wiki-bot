import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { createWorker, type MentionEvent, type WorkerDeps } from '../src/worker.js';
import type { QueryRecord } from '../src/query-store.js';

const silentLogger = pino({ level: 'silent' });

function makeDeps(overrides: Partial<WorkerDeps> = {}) {
  const recorded: QueryRecord[] = [];
  const posted: { text: string }[] = [];
  const deps: WorkerDeps = {
    logger: silentLogger,
    postMessage: vi.fn(async (m: { channel: string; thread_ts: string; text: string }) => {
      posted.push({ text: m.text });
    }),
    fetchPriorTurns: vi.fn(async () => []),
    withReadLock: async <T>(fn: () => Promise<T>) => fn(),
    wikiPath: '/tmp/wiki',
    githubBaseUrl: 'https://github.com/o/r',
    branch: 'main',
    model: 'claude-sonnet-4-6',
    timeoutMs: 30_000,
    recordQuery: (r: QueryRecord) => {
      recorded.push(r);
    },
    runAgent: vi.fn(async () => 'OK'),
    scanWikiPages: vi.fn(async () => new Map<string, string>()),
    ...overrides,
  };
  return { deps, recorded, posted };
}

const baseEvent: MentionEvent = {
  channel: 'C1',
  thread_ts: '111.222',
  user: 'U1',
  text: '<@UBOT> 안녕',
  eventId: 'evt-x',
  botUserId: 'UBOT',
};

describe('worker finalize', () => {
  it('정상 흐름은 status=success로 1건 기록', async () => {
    const { deps, recorded } = makeDeps();
    const worker = createWorker(deps);
    await worker(baseEvent);
    expect(recorded).toHaveLength(1);
    const r = recorded[0]!;
    expect(r.status).toBe('success');
    expect(r.question).toBe('안녕');
    expect(r.eventId).toBe('evt-x');
  });

  it('빈 질문은 status=empty', async () => {
    const { deps, recorded } = makeDeps();
    const worker = createWorker(deps);
    await worker({ ...baseEvent, text: '<@UBOT>' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.status).toBe('empty');
  });

  it('AbortError는 status=timeout', async () => {
    const { deps, recorded } = makeDeps({
      runAgent: vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    });
    const worker = createWorker(deps);
    await worker(baseEvent);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.status).toBe('timeout');
  });

  it('기타 예외는 status=error + errorMessage 보존', async () => {
    const { deps, recorded } = makeDeps({
      runAgent: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    const worker = createWorker(deps);
    await worker(baseEvent);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.status).toBe('error');
    expect(recorded[0]!.errorMessage).toBe('rate limited');
  });

  it('recordQuery 실패해도 사용자 응답 흐름은 정상', async () => {
    const { deps, posted } = makeDeps({
      recordQuery: () => {
        throw new Error('disk full');
      },
    });
    const worker = createWorker(deps);
    await expect(worker(baseEvent)).resolves.toBeUndefined();
    expect(posted.length).toBeGreaterThan(0);
  });
});
