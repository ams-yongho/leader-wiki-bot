import { describe, it, expect } from 'vitest';
import { createWorkQueue } from '../src/queue.js';

describe('createWorkQueue', () => {
  it('add()는 작업이 실행되면 resolve', async () => {
    const q = createWorkQueue({ concurrency: 1, maxSize: 10 });
    const result = await q.add(async () => 42);
    expect(result).toBe(42);
  });

  it('maxSize 초과 시 add는 throw with QueueFullError', async () => {
    const q = createWorkQueue({ concurrency: 1, maxSize: 1 });
    // 현재 실행중 + pending=1을 만들기 위해 첫 작업을 지연시킴
    const slow = q.add(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    q.add(async () => 'pending');
    expect(() => q.add(async () => 'overflow')).toThrow(/Queue full/);
    await slow;
  });

  it('size는 현재 큐 크기를 리포트', async () => {
    const q = createWorkQueue({ concurrency: 1, maxSize: 5 });
    const slow = q.add(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    q.add(async () => 'a');
    expect(q.size).toBeGreaterThanOrEqual(1);
    await slow;
  });
});
