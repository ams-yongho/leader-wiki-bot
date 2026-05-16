import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { buildPageIndex } from './citations.js';

export async function scanWikiPages(rootPath: string): Promise<Map<string, string>> {
  const files: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(relative(rootPath, full));
    }
  }
  await walk(rootPath);
  return buildPageIndex(files);
}
