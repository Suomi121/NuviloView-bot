import { createHash } from 'node:crypto';
import { isResetDeveloper } from './guild-reset-utils.mjs';
import { serializeJson } from './storage/contracts.mjs';
export const isNewsDeveloper = isResetDeveloper;
export const newsDigest = value => createHash('sha256').update(serializeJson(value)).digest('hex');
export function newsError(code) { throw Object.assign(new Error(code), { code }); }
export const newsIdValid = value => typeof value === 'string' && /^\d{16,22}$/.test(value);
const safeText = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  .replace(/@(everyone|here)/gi, '＠$1').replace(/<(@[!&]?|#)(\d+)>/g, '［$2］');
export function validateNews(input) {
  const title = safeText(input?.title).trim(), body = safeText(input?.body).trim();
  if (!title || title.length > 256 || !body || body.length > 4000) newsError('NEWS_CONTENT_LIMIT');
  if (/(?:javascript|data|file|vbscript):/i.test(title + '\n' + body)) newsError('NEWS_URL');
  let url = String(input?.url ?? '').trim();
  if (url) {
    if (url.length > 1024) newsError('NEWS_URL');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
          !parsed.hostname.includes('.') || /(?:localhost|\.local|\.internal)$/.test(parsed.hostname) ||
          /^(?:\d+\.){3}\d+$/.test(parsed.hostname) || parsed.hostname.includes(':')) newsError('NEWS_URL');
      url = parsed.href;
    } catch { newsError('NEWS_URL'); }
  }
  const color = String(input?.color || '#5865f2');
  if (!/^#[a-f\d]{6}$/i.test(color)) newsError('NEWS_COLOR');
  return { title, body, url, color };
}
export function newsPayload(news) {
  const content = validateNews(news.content);
  return { embeds: [{ title: content.title, description: content.body, color: parseInt(content.color.slice(1), 16),
    ...(content.url ? { url: content.url } : {}), footer: { text: `NuviloView News · ${news.id}` } }],
  allowedMentions: { parse: [], repliedUser: false } };
}
export function classifyNewsFailure(error) {
  const status = Number(error?.status ?? error?.httpStatus);
  if (status === 429) return 'RATE_LIMIT';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 400 && status < 500 && status !== 408) return 'REJECTED';
  return 'UNKNOWN'; // timeouts / 5xx / lost responses are never automatically retried
}
