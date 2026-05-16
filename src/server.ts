import bolt from '@slack/bolt';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createWorkQueue, QueueFullError } from './queue.js';
import { createWorker, type MentionEvent } from './worker.js';
import { createWikiSync } from './wiki-sync.js';
import {
  fetchPriorTurns as fetchPriorTurnsImpl,
  type SlackMessage,
} from './thread-context.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const app = new bolt.App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  signingSecret: config.SLACK_SIGNING_SECRET,
  socketMode: config.SLACK_MODE === 'socket',
  logger: {
    debug: (...m: unknown[]) => logger.debug({ scope: 'bolt' }, m.join(' ')),
    info: (...m: unknown[]) => logger.info({ scope: 'bolt' }, m.join(' ')),
    warn: (...m: unknown[]) => logger.warn({ scope: 'bolt' }, m.join(' ')),
    error: (...m: unknown[]) => logger.error({ scope: 'bolt' }, m.join(' ')),
    setLevel: (_level: bolt.LogLevel) => {},
    getLevel: () => bolt.LogLevel.INFO,
    setName: (_name: string) => {},
  },
});

const wikiSync = createWikiSync({
  localPath: config.WIKI_LOCAL_PATH,
  repoUrl: config.WIKI_REPO_URL,
  branch: config.WIKI_REPO_BRANCH,
  logger,
});
await wikiSync.ensureCloned();
if (config.WIKI_REPO_URL) {
  wikiSync.scheduleCron(config.WIKI_SYNC_INTERVAL_CRON);
  logger.info({ cron: config.WIKI_SYNC_INTERVAL_CRON }, 'wiki cron scheduled');
}

const queue = createWorkQueue({
  concurrency: config.MAX_CONCURRENT_AGENTS,
  maxSize: config.QUEUE_MAX_SIZE,
});

let botUserId = '';

const worker = createWorker({
  logger,
  postMessage: async ({ channel, thread_ts, text }) => {
    await app.client.chat.postMessage({ channel, thread_ts, text });
  },
  fetchPriorTurns: (channel, thread_ts, botUserId) =>
    fetchPriorTurnsImpl({
      channel,
      thread_ts,
      botUserId,
      conversationsReplies: async ({ channel: ch, ts }) => {
        const r = await app.client.conversations.replies({ channel: ch, ts });
        return { messages: (r.messages ?? []) as unknown as SlackMessage[] };
      },
    }),
  withReadLock: (fn) => wikiSync.withReadLock(fn),
  wikiPath: config.WIKI_LOCAL_PATH,
  githubBaseUrl: config.WIKI_REPO_GITHUB_URL,
  branch: config.WIKI_REPO_BRANCH,
  model: config.ANTHROPIC_MODEL,
  timeoutMs: config.AGENT_TIMEOUT_MS,
});

app.event('app_mention', async ({ event, body }) => {
  // Ignore Slack retries to avoid duplicate processing
  const retryNum = (body as { retryNum?: number }).retryNum;
  if (retryNum !== undefined && retryNum > 0) {
    logger.warn({ retryNum }, 'skipping Slack retry');
    return;
  }

  const mention: MentionEvent = {
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    user: event.user ?? 'unknown',
    text: event.text ?? '',
    eventId: event.ts,
    botUserId,
  };

  try {
    queue.add(() => worker(mention)).catch((err: unknown) => {
      logger.error({ err, eventId: mention.eventId }, 'worker failed');
    });
  } catch (err) {
    if (err instanceof QueueFullError) {
      await app.client.chat.postMessage({
        channel: mention.channel,
        thread_ts: mention.thread_ts,
        text: '지금 많이 바빠요. 잠시 후 다시 멘션해주세요.',
      });
      return;
    }
    throw err;
  }
});

// HTTP 모드일 때만 헬스체크 노출
if (config.SLACK_MODE === 'http') {
  // `app.receiver` is private in Bolt's type definitions, but it is
  // a public runtime property on the App instance. We cast through
  // `unknown` to access it — safe because this block only runs when
  // socketMode is false, meaning Bolt used ExpressReceiver which does
  // expose `.app` (Express Application) at runtime.
  type AppWithReceiver = {
    receiver: {
      app: {
        get: (
          path: string,
          handler: (
            req: unknown,
            res: { json: (body: unknown) => void },
          ) => void,
        ) => void;
      };
    };
  };
  (app as unknown as AppWithReceiver).receiver.app.get('/healthz', (_req, res) => {
    res.json({ ok: true, queue: queue.size, pending: queue.pending });
  });
}

const authResult = await app.client.auth.test();
botUserId = (authResult.user_id as string) ?? '';
logger.info({ botUserId }, 'bot identity resolved');

await app.start(config.PORT);
logger.info({ port: config.PORT, mode: config.SLACK_MODE }, 'bot started');
