import { describe, it, expect } from 'vitest';
import { messagesToTurns, stripMention } from '../src/thread-context.js';

describe('messagesToTurns', () => {
  const botUserId = 'UBOT';

  it('봇 메시지는 assistant, 그 외 사용자는 user로 매핑', () => {
    const msgs = [
      { user: 'U1', text: '<@UBOT> 안녕', ts: '1' },
      { bot_id: 'B1', user: 'UBOT', text: '안녕하세요', ts: '2' },
      { user: 'U1', text: '<@UBOT> 더 자세히', ts: '3' },
    ];
    const turns = messagesToTurns(msgs, botUserId);
    expect(turns).toEqual([
      { role: 'user', content: '안녕' },
      { role: 'assistant', content: '안녕하세요' },
      { role: 'user', content: '더 자세히' },
    ]);
  });

  it('마지막 사용자 멘션은 새 prompt이므로 제외 (excludeLast=true)', () => {
    const msgs = [
      { user: 'U1', text: '<@UBOT> Q1', ts: '1' },
      { user: 'UBOT', text: 'A1', ts: '2' },
      { user: 'U1', text: '<@UBOT> Q2 (current)', ts: '3' },
    ];
    const turns = messagesToTurns(msgs, botUserId, { excludeLast: true });
    expect(turns).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]);
  });

  it('maxTurns로 잘라냄', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      user: i % 2 === 0 ? 'U1' : 'UBOT',
      text: `m${i}`,
      ts: String(i),
    }));
    const turns = messagesToTurns(msgs, botUserId, { maxTurns: 4 });
    expect(turns.length).toBe(4);
    expect(turns.at(-1)?.content).toBe('m19');
  });
});

describe('stripMention', () => {
  it('<@USER> 패턴 제거', () => {
    expect(stripMention('<@UABC> 안녕')).toBe('안녕');
    expect(stripMention('앞 <@UABC> 뒤')).toBe('앞  뒤');
  });
});
