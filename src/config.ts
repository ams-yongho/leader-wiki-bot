import { z } from 'zod';

const Schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_MODE: z.enum(['socket', 'http']).default('socket'),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  WIKI_REPO_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  WIKI_REPO_BRANCH: z.string().default('main'),
  WIKI_LOCAL_PATH: z.string().min(1),
  WIKI_SYNC_INTERVAL_CRON: z.string().default('*/5 * * * *'),
  WIKI_REPO_GITHUB_URL: z.url(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().min(1).max(10).default(2),
  QUEUE_MAX_SIZE: z.coerce.number().int().min(1).default(20),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
  PORT: z.coerce.number().int().default(3000),

  QUERY_LOG_ENABLED: z
    .preprocess((v) => {
      if (v === undefined || v === '') return true;
      if (v === 'false' || v === '0') return false;
      if (v === 'true' || v === '1') return true;
      return v;
    }, z.boolean())
    .default(true),
  QUERY_LOG_DB_PATH: z.string().min(1).default('/workspace/data/queries.db'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const cfg = Schema.parse(process.env);
  if (cfg.SLACK_MODE === 'socket' && !cfg.SLACK_APP_TOKEN) {
    throw new Error('SLACK_APP_TOKEN is required when SLACK_MODE=socket');
  }
  if (cfg.SLACK_MODE === 'http' && !cfg.SLACK_SIGNING_SECRET) {
    throw new Error('SLACK_SIGNING_SECRET is required when SLACK_MODE=http');
  }
  if (!cfg.ANTHROPIC_API_KEY && !cfg.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('Either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required');
  }
  return cfg;
}
