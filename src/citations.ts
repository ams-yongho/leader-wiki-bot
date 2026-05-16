import { basename } from 'node:path';

const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

export interface CitationContext {
  pages: Map<string, string>;
  githubBaseUrl: string;
  branch: string;
}

export function buildPageIndex(files: string[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const file of files) {
    if (!file.startsWith('wiki/')) continue;
    if (!file.endsWith('.md')) continue;
    const name = basename(file, '.md');
    if (!idx.has(name)) idx.set(name, file);
  }
  return idx;
}

export function replaceCitations(text: string, ctx: CitationContext): string {
  return text.replace(WIKILINK_RE, (match, raw: string, display?: string) => {
    const name = raw.trim();
    const path = ctx.pages.get(name);
    if (!path) return match;
    const url = `${ctx.githubBaseUrl}/blob/${ctx.branch}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const label = (display ?? name).trim();
    return `<${url}|${label}>`;
  });
}
