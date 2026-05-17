export function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; name?: string; message?: string };
  if (e.status === 429) return true;
  return Boolean(e.message?.toLowerCase().includes('rate limit'));
}

export interface RetryOpts {
  backoffMs?: number;
  jitterMs?: number;
  logger?: { warn: (...a: unknown[]) => void };
}

export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    const delay = (opts.backoffMs ?? 2000) + Math.random() * (opts.jitterMs ?? 1000);
    opts.logger?.warn({ err, delay }, 'rate limited, retrying once');
    await new Promise((r) => setTimeout(r, delay));
    return fn();
  }
}
