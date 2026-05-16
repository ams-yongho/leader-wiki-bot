import { z } from 'zod';

const Schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_MODE: z.enum(['socket', 'http']).default('socket'),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  WIKI_REPO_URL: z.string().optional(),
  WIKI_REPO_BRANCH: z.string().default('main'),
  WIKI_LOCAL_PATH: z.string().min(1),
  WIKI_SYNC_INTERVAL_CRON: z.string().default('*/5 * * * *'),
  WIKI_REPO_GITHUB_URL: z.url(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().min(1).max(10).default(2),
  QUEUE_MAX_SIZE: z.coerce.number().int().min(1).default(20),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
  PORT: z.coerce.number().int().default(3000),
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
  return cfg;
}
