import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './logger.js';
import { retryOnRateLimit } from './retry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PriorTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskAgentInput {
  question: string;
  priorTurns: PriorTurn[];
}

export interface AskAgentOptions {
  cwd: string;
  model: string;
  timeoutMs: number;
  logger: Logger;
}

export async function loadSystemPrompt(): Promise<string> {
  // dev: src/prompts/system.md (running from src/ via tsx)
  // prod: dist/prompts/system.md (Dockerfile copies src/prompts → dist/prompts)
  const candidates = [
    join(__dirname, 'prompts', 'system.md'),
    join(__dirname, '..', 'src', 'prompts', 'system.md'),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      // try next candidate
    }
  }
  throw new Error('system prompt not found — checked: ' + candidates.join(', '));
}

/**
 * Serialize prior conversation turns as a text preamble prepended to the
 * current question. The Claude Agent SDK does not expose a direct
 * message-injection option, so we fall back to structured text.
 */
function buildPrompt(question: string, priorTurns: PriorTurn[]): string {
  if (priorTurns.length === 0) {
    return question;
  }

  const lines: string[] = ['[과거 대화]'];
  for (const turn of priorTurns) {
    const label = turn.role === 'user' ? '사용자' : '어시스턴트';
    lines.push(`${label}: ${turn.content}`);
  }
  lines.push('[현재 질문]', question);
  return lines.join('\n');
}

async function runOnce(
  input: AskAgentInput,
  opts: AskAgentOptions,
  systemPrompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const prompt = buildPrompt(input.question, input.priorTurns);

    const result = query({
      prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        systemPrompt,
        // Restrict to read-only built-in tools only
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        abortController: controller,
        persistSession: false,
        env: process.env as Record<string, string>,
        stderr: (data: string) => {
          opts.logger.warn({ claudeStderr: data.toString().trim() }, 'claude cli stderr');
        },
      },
    });

    let answer = '';

    for await (const message of result as AsyncIterable<SDKMessage>) {
      if (message.type === 'result' && message.subtype === 'success') {
        // SDKResultSuccess.result is the final synthesised answer string
        answer = message.result;
        break;
      }
    }

    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function askAgent(input: AskAgentInput, opts: AskAgentOptions): Promise<string> {
  const systemPrompt = await loadSystemPrompt();
  opts.logger.debug({ question: input.question, priorTurns: input.priorTurns.length }, 'askAgent start');
  const answer = await retryOnRateLimit(() => runOnce(input, opts, systemPrompt), {
    logger: opts.logger,
  });
  opts.logger.debug({ answerLength: answer.length }, 'askAgent done');
  return answer;
}
