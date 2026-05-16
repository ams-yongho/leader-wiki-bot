import { describe, it, expect } from 'vitest';
import { toSlackMrkdwn, splitForSlack } from '../src/slack-format.js';

describe('toSlackMrkdwn', () => {
  it('**bold** → *bold*', () => {
    expect(toSlackMrkdwn('**hi**')).toContain('*hi*');
  });

  it('[text](url) → <url|text>', () => {
    expect(toSlackMrkdwn('[foo](https://a.com)')).toContain('<https://a.com|foo>');
  });

  it('이미 슬랙 링크 형식 (<url|label>)은 보존', () => {
    const input = 'see <https://a.com|foo>';
    const out = toSlackMrkdwn(input);
    expect(out).toContain('<https://a.com|foo>');
  });
});

describe('splitForSlack', () => {
  it('4000자 이하는 한 메시지', () => {
    const r = splitForSlack('hello');
    expect(r).toEqual(['hello']);
  });

  it('4000자 초과는 분할', () => {
    const long = 'a'.repeat(8500);
    const r = splitForSlack(long);
    expect(r.length).toBe(3);
    expect(r.every((s) => s.length <= 4000)).toBe(true);
    expect(r.join('')).toBe(long);
  });

  it('가능하면 줄 단위로 분할', () => {
    const long = ('line\n'.repeat(900)).trimEnd(); // ~4500자
    const r = splitForSlack(long);
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r.every((s) => s.length <= 4000)).toBe(true);
  });
});
