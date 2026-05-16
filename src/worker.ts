import type { Logger } from './logger.js';
import { askAgent, type PriorTurn } from './agent.js';
import { replaceCitations } from './citations.js';
import { scanWikiPages } from './page-index.js';
import { toSlackMrkdwn, splitForSlack } from './slack-format.js';

export interface MentionEvent {
  channel: string;
  thread_ts: string;
  user: string;
  text: string;
  eventId: string;
  botUserId: string;
}

export interface WorkerDeps {
  logger: Logger;
  postMessage: (args: { channel: string; thread_ts: string; text: string }) => Promise<void>;
  fetchPriorTurns: (channel: string, thread_ts: string, botUserId: string) => Promise<PriorTurn[]>;
  withReadLock: <T>(fn: () => Promise<T>) => Promise<T>;
  wikiPath: string;
  githubBaseUrl: string;
  branch: string;
  model: string;
  timeoutMs: number;
}

const MENTION_RE = /<@[A-Z0-9]+>/g;

export function createWorker(deps: WorkerDeps) {
  return async (event: MentionEvent): Promise<void> => {
    const log = deps.logger.child({ eventId: event.eventId, user: event.user });
    const question = event.text.replace(MENTION_RE, '').trim();
    if (!question) {
      await deps.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '질문 내용이 비어있습니다. `@leader-wiki-bot <질문>` 형식으로 멘션해주세요.',
      });
      return;
    }

    try {
      const priorTurns = await deps.fetchPriorTurns(event.channel, event.thread_ts, event.botUserId);
      log.info({ priorTurns: priorTurns.length }, 'gathered thread context');

      const answer = await deps.withReadLock(async () => {
        const pages = await scanWikiPages(deps.wikiPath);
        const raw = await askAgent(
          { question, priorTurns },
          { cwd: deps.wikiPath, model: deps.model, timeoutMs: deps.timeoutMs, logger: log },
        );
        const cited = replaceCitations(raw, {
          pages,
          githubBaseUrl: deps.githubBaseUrl,
          branch: deps.branch,
        });
        return toSlackMrkdwn(cited);
      });

      const chunks = splitForSlack(answer);
      for (const chunk of chunks) {
        await deps.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: chunk });
      }
    } catch (err) {
      log.error({ err }, 'worker failed');
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? '응답이 지연되어 중단되었습니다. 잠시 후 다시 시도해주세요.'
          : '답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      await deps.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: msg });
    }
  };
}
