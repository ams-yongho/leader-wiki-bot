import PQueue from 'p-queue';

export class QueueFullError extends Error {
  constructor() {
    super('Queue full');
    this.name = 'QueueFullError';
  }
}

export interface WorkQueueOptions {
  concurrency: number;
  maxSize: number;
}

export interface WorkQueue {
  add<T>(task: () => Promise<T>): Promise<T>;
  readonly size: number;
  readonly pending: number;
}

export function createWorkQueue(opts: WorkQueueOptions): WorkQueue {
  const pq = new PQueue({ concurrency: opts.concurrency });
  return {
    add<T>(task: () => Promise<T>): Promise<T> {
      if (pq.size >= opts.maxSize) {
        throw new QueueFullError();
      }
      return pq.add(task) as Promise<T>;
    },
    get size() {
      return pq.size;
    },
    get pending() {
      return pq.pending;
    },
  };
}
