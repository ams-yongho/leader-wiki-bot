import type { Logger } from './logger.js';

export interface WorkerDeps {
  logger: Logger;
  postMessage: (args: { channel: string; thread_ts: string; text: string }) => Promise<void>;
}

export interface MentionEvent {
  channel: string;
  thread_ts: string;
  user: string;
  text: string;
  eventId: string;
}

export function createEchoWorker(deps: WorkerDeps) {
  return async (event: MentionEvent): Promise<void> => {
    deps.logger.info({ eventId: event.eventId, user: event.user }, 'handling mention');
    await deps.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `안녕하세요 <@${event.user}>! 받은 메시지: ${event.text}`,
    });
  };
}
