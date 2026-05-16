import slackifyMarkdown from 'slackify-markdown';

const SLACK_LIMIT = 4000;
const SLACK_LINK_RE = /<(https?:[^>|]+)\|([^>]+)>/g;
// Use a placeholder that slackify-markdown will leave untouched.
// The format SLACKPROTECT_N_ is plain alphanumeric/underscore, safe from markdown processing.
const PLACEHOLDER_RE = /SLACKPROTECT_(\d+)_/g;

export function toSlackMrkdwn(markdown: string): string {
  // slackify-markdown may rewrite or strip <url|label> Slack link syntax.
  // Protect existing Slack links by replacing them with safe alphanumeric placeholders,
  // run the conversion, then restore them.
  const protected_: string[] = [];
  const withPlaceholders = markdown.replace(SLACK_LINK_RE, (_m, url: string, label: string) => {
    const idx = protected_.length;
    protected_.push(`<${url}|${label}>`);
    return `SLACKPROTECT_${idx}_`;
  });
  const converted = slackifyMarkdown(withPlaceholders);
  return converted.replace(PLACEHOLDER_RE, (_m, idx) => protected_[Number(idx)] ?? '');
}

export function splitForSlack(text: string, limit = SLACK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Try to cut at a newline boundary within the limit
    let cut = remaining.lastIndexOf('\n', limit);
    // If no suitable newline found (too early), do a hard cut at limit
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
