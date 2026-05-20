import type { Db } from './db.js';

export type QueryStatus = 'success' | 'empty' | 'timeout' | 'error';

export interface QueryRecord {
  eventId: string;
  receivedAt: string;
  completedAt: string;
  channel: string;
  threadTs: string;
  slackUser: string;
  question: string;
  questionRaw: string;
  priorTurns: number;
  answer: string | null;
  citations: string[] | null;
  model: string;
  status: QueryStatus;
  errorMessage: string | null;
}

export interface QueryStore {
  recordQuery: (entry: QueryRecord) => void;
}

const INSERT_SQL = `
  INSERT INTO queries (
    event_id, received_at, completed_at, channel, thread_ts, slack_user,
    question, question_raw, prior_turns, answer, citations_json,
    model, latency_ms, status, error_message
  ) VALUES (
    @eventId, @receivedAt, @completedAt, @channel, @threadTs, @slackUser,
    @question, @questionRaw, @priorTurns, @answer, @citationsJson,
    @model, @latencyMs, @status, @errorMessage
  )
`;

function computeLatency(receivedAt: string, completedAt: string): number | null {
  const start = Date.parse(receivedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

export function createQueryStore(db: Db): QueryStore {
  const stmt = db.prepare(INSERT_SQL);
  return {
    recordQuery: (entry) => {
      const params = {
        eventId: entry.eventId,
        receivedAt: entry.receivedAt,
        completedAt: entry.completedAt,
        channel: entry.channel,
        threadTs: entry.threadTs,
        slackUser: entry.slackUser,
        question: entry.question,
        questionRaw: entry.questionRaw,
        priorTurns: entry.priorTurns,
        answer: entry.answer,
        citationsJson: entry.citations === null ? null : JSON.stringify(entry.citations),
        model: entry.model,
        latencyMs: computeLatency(entry.receivedAt, entry.completedAt),
        status: entry.status,
        errorMessage: entry.errorMessage,
      };
      try {
        stmt.run(params);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // Slack retry로 인한 중복 event_id — 정상 무시
          return;
        }
        throw err;
      }
    },
  };
}

export function noopQueryStore(): QueryStore {
  return { recordQuery: () => {} };
}
