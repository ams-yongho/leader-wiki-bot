import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  const setValidEnv = () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.WIKI_LOCAL_PATH = '/tmp/wiki';
    process.env.WIKI_REPO_GITHUB_URL = 'https://github.com/amass/leader-wiki';
  };

  it('필수 변수가 모두 있으면 파싱 성공', () => {
    setValidEnv();
    const cfg = loadConfig();
    expect(cfg.SLACK_MODE).toBe('socket');
    expect(cfg.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6');
    expect(cfg.MAX_CONCURRENT_AGENTS).toBe(2);
  });

  it('SLACK_BOT_TOKEN 없으면 throw', () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(() => loadConfig()).toThrow();
  });

  it('SLACK_MODE=http이고 SIGNING_SECRET 없으면 throw', () => {
    setValidEnv();
    process.env.SLACK_MODE = 'http';
    expect(() => loadConfig()).toThrow(/SLACK_SIGNING_SECRET/);
  });

  it('WIKI_REPO_GITHUB_URL이 URL 형식이 아니면 throw', () => {
    setValidEnv();
    process.env.WIKI_REPO_GITHUB_URL = 'not-a-url';
    expect(() => loadConfig()).toThrow();
  });

  it('MAX_CONCURRENT_AGENTS가 max(10)를 넘으면 throw', () => {
    setValidEnv();
    process.env.MAX_CONCURRENT_AGENTS = '15';
    expect(() => loadConfig()).toThrow();
  });

  it('LOG_LEVEL이 유효하지 않은 enum이면 throw', () => {
    setValidEnv();
    process.env.LOG_LEVEL = 'verbose';
    expect(() => loadConfig()).toThrow();
  });
});
