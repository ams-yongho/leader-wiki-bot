import pino from 'pino';

export const createLogger = (level: string) =>
  pino({
    level,
    base: { service: 'leader-wiki-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

export type Logger = ReturnType<typeof createLogger>;
