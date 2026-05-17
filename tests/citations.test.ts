import { describe, it, expect } from 'vitest';
import { buildPageIndex, replaceCitations } from '../src/citations.js';

describe('citations', () => {
  const pages = new Map([
    ['프로젝트-알파', 'wiki/프로젝트-알파.md'],
    ['김아무개', 'wiki/people/김아무개.md'],
  ]);
  const githubBase = 'https://github.com/amass/leader-wiki';

  it('알려진 페이지명은 slack 링크로 치환', () => {
    const out = replaceCitations('자세한 건 [[프로젝트-알파]] 참고', {
      pages,
      githubBaseUrl: githubBase,
      branch: 'main',
    });
    expect(out).toBe(
      '자세한 건 <https://github.com/amass/leader-wiki/blob/main/wiki/%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8-%EC%95%8C%ED%8C%8C.md|프로젝트-알파> 참고',
    );
  });

  it('표시 텍스트가 있는 형식도 처리: [[페이지|텍스트]]', () => {
    const out = replaceCitations('[[김아무개|아무개]] 님', {
      pages,
      githubBaseUrl: githubBase,
      branch: 'main',
    });
    expect(out).toContain('|아무개>');
    expect(out).toContain('wiki/people/');
  });

  it('알 수 없는 페이지명은 원본 유지', () => {
    const out = replaceCitations('[[없는페이지]]', {
      pages,
      githubBaseUrl: githubBase,
      branch: 'main',
    });
    expect(out).toBe('[[없는페이지]]');
  });

  it('buildPageIndex는 .md 파일을 페이지명→경로로 매핑', () => {
    const idx = buildPageIndex([
      'wiki/index.md',
      'wiki/프로젝트-알파.md',
      'wiki/people/김아무개.md',
      'raw/2026-05-16.md',
    ]);
    expect(idx.get('프로젝트-알파')).toBe('wiki/프로젝트-알파.md');
    expect(idx.get('김아무개')).toBe('wiki/people/김아무개.md');
    expect(idx.has('2026-05-16')).toBe(false);
  });
});
