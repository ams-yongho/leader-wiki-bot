import type { Logger } from './logger.js';
import { askAgent as defaultAskAgent, type PriorTurn } from './agent.js';
import { replaceCitations } from './citations.js';
import { scanWikiPages as defaultScanWikiPages } from './page-index.js';
import { toSlackMrkdwn, splitForSlack } from './slack-format.js';
import type { QueryRecord, QueryStatus } from './query-store.js';

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
  recordQuery: (entry: QueryRecord) => void;
  runAgent?: typeof defaultAskAgent;
  scanWikiPages?: typeof defaultScanWikiPages;
}

const MENTION_RE = /<@[A-Z0-9]+>/g;

export function createWorker(deps: WorkerDeps) {
  const runAgent = deps.runAgent ?? defaultAskAgent;
  const scanWikiPages = deps.scanWikiPages ?? defaultScanWikiPages;

  return async (event: MentionEvent): Promise<void> => {
    const receivedAt = new Date().toISOString();
    const log = deps.logger.child({ eventId: event.eventId, user: event.user });
    const question = event.text.replace(MENTION_RE, '').trim();

    const finalize = (
      status: QueryStatus,
      opts: {
        priorTurns?: number;
        answer?: string | null;
        citations?: string[] | null;
        errorMessage?: string | null;
      },
    ) => {
      try {
        deps.recordQuery({
          eventId: event.eventId,
          receivedAt,
          completedAt: new Date().toISOString(),
          channel: event.channel,
          threadTs: event.thread_ts,
          slackUser: event.user,
          question,
          questionRaw: event.text,
          priorTurns: opts.priorTurns ?? 0,
          answer: opts.answer ?? null,
          citations: opts.citations ?? null,
          model: deps.model,
          status,
          errorMessage: opts.errorMessage ?? null,
        });
      } catch (err) {
        log.error({ err }, 'failed to persist query record');
      }
    };

    if (!question) {
      await deps.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '질문 내용이 비어있습니다. `@leader-wiki-bot <질문>` 형식으로 멘션해주세요.',
      });
      finalize('empty', {});
      return;
    }

    let priorTurnsCount = 0;
    try {
      const priorTurns = await deps.fetchPriorTurns(event.channel, event.thread_ts, event.botUserId);
      priorTurnsCount = priorTurns.length;
      log.info({ priorTurns: priorTurnsCount }, 'gathered thread context');

      const { answer, citations } = await deps.withReadLock(async () => {
        const pages = await scanWikiPages(deps.wikiPath);
        const raw = await runAgent(
          { question, priorTurns },
          { cwd: deps.wikiPath, model: deps.model, timeoutMs: deps.timeoutMs, logger: log },
        );
        const cited = replaceCitations(raw, {
          pages,
          githubBaseUrl: deps.githubBaseUrl,
          branch: deps.branch,
        });
        return { answer: toSlackMrkdwn(cited.text), citations: cited.citations };
      });

      if (!answer.trim()) {
        await deps.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: '답변을 생성할 수 없었습니다. 잠시 후 다시 시도해주세요.',
        });
        finalize('empty', { priorTurns: priorTurnsCount });
        return;
      }

      const chunks = splitForSlack(answer);
      for (const chunk of chunks) {
        await deps.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: chunk });
      }

      finalize('success', { priorTurns: priorTurnsCount, answer, citations });
    } catch (err) {
      log.error({ err }, 'worker failed');
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = isAbort
        ? '응답이 지연되어 중단되었습니다. 잠시 후 다시 시도해주세요.'
        : '답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      await deps.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: msg });
      finalize(isAbort ? 'timeout' : 'error', {
        priorTurns: priorTurnsCount,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
