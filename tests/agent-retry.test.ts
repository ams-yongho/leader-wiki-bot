import { describe, it, expect, vi } from 'vitest';
import { retryOnRateLimit } from '../src/retry.js';

describe('retryOnRateLimit', () => {
  it('429를 던지면 한 번 재시도', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const e = new Error('rate limit') as Error & { status: number };
        e.status = 429;
        throw e;
      }
      return 'ok';
    });
    const r = await retryOnRateLimit(fn, { backoffMs: 1, jitterMs: 0 });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rate-limit이 아니면 즉시 throw', async () => {
    const fn = vi.fn(async () => {
      throw new Error('other');
    });
    await expect(retryOnRateLimit(fn)).rejects.toThrow('other');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
