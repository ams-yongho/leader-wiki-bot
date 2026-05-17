import type { PriorTurn } from './agent.js';

export interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
}

/**
 * Remove all Slack user-mention tokens (<@USERID>) from text and trim
 * leading/trailing whitespace.
 *
 * Internal whitespace (e.g. double-space when a mention sits in the middle)
 * is preserved exactly as-is.
 */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

export interface MessagesToTurnsOpts {
  /** Maximum number of turns to keep (most-recent wins). Default: 12. */
  maxTurns?: number;
  /** Drop the last message (current prompt that is being processed). Default: false. */
  excludeLast?: boolean;
}

/**
 * Convert a flat list of Slack thread messages into PriorTurn pairs
 * suitable for the agent context window.
 *
 * Rules:
 *  - Messages are sorted by ts (ascending) before processing.
 *  - A message is "assistant" if its user field equals botUserId OR it has a bot_id.
 *  - All other messages are "user".
 *  - Mention tokens are stripped from content.
 *  - Empty messages (after stripping) are discarded.
 *  - If excludeLast is true, the last message in the sorted list is dropped
 *    (it is the current incoming prompt and must not be repeated as context).
 *  - If the result exceeds maxTurns, only the most-recent turns are kept.
 */
export function messagesToTurns(
  msgs: SlackMessage[],
  botUserId: string,
  opts: MessagesToTurnsOpts = {},
): PriorTurn[] {
  const sorted = [...msgs].sort((a, b) => Number(a.ts) - Number(b.ts));
  const source = opts.excludeLast ? sorted.slice(0, -1) : sorted;

  const turns: PriorTurn[] = source
    .filter((m) => (m.text ?? '').trim().length > 0)
    .map((m) => {
      const isBot = m.user === botUserId || Boolean(m.bot_id);
      return {
        role: isBot ? ('assistant' as const) : ('user' as const),
        content: stripMention(m.text ?? ''),
      };
    })
    .filter((t) => t.content.length > 0);

  const max = opts.maxTurns ?? 12;
  return turns.length > max ? turns.slice(turns.length - max) : turns;
}

// ---------------------------------------------------------------------------
// Slack API integration
// ---------------------------------------------------------------------------

export interface FetchThreadOpts {
  channel: string;
  thread_ts: string;
  botUserId: string;
  conversationsReplies: (args: {
    channel: string;
    ts: string;
  }) => Promise<{ messages?: SlackMessage[] }>;
}

/**
 * Fetch the thread from the Slack API and convert it to prior turns.
 * The last message (the current prompt) is always excluded.
 */
export async function fetchPriorTurns(opts: FetchThreadOpts): Promise<PriorTurn[]> {
  const result = await opts.conversationsReplies({
    channel: opts.channel,
    ts: opts.thread_ts,
  });
  return messagesToTurns(result.messages ?? [], opts.botUserId, {
    excludeLast: true,
    maxTurns: 12,
  });
}
