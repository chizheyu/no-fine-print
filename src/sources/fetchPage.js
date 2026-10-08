// Fetch a rules page and turn it into plain text we can quote against.
//
// Two lessons are built in. First, this runs on a public server, so it refuses
// private and metadata addresses (including after redirects and DNS). Second, bad
// input should fail before it costs a model call: a JavaScript-only shell or a
// garbled download is reported as such, not passed downstream.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const UA = 'Mozilla/5.0 (compatible; NoFinePrint/0.1; +https://github.com/chizheyu/no-fine-print)';
const MAX_BYTES = 3_000_000;

function privateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function checkUrl(raw, { resolve = lookup } = {}) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'Not a valid URL.' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'Only http and https links are supported.' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'That address is not public.' };
  const addresses = isIP(host) ? [host] : (await resolve(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) return { ok: false, reason: 'Could not resolve that host.' };
  if (addresses.some(privateAddress)) return { ok: false, reason: 'That address is not public.' };
  return { ok: true, url };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre|table|ul|ol|dt|dd)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function titleOf(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

// Is this text worth sending to a model?
export function assessText(text) {
  const t = String(text || '');
  if (t.length < 400) {
    return { ok: false, reason: /enable javascript|requires javascript|loading/i.test(t)
      ? 'The page only renders in a browser (JavaScript app). Paste the rules text instead.'
      : 'Too little text on that page to read the rules from. Paste the rules text instead.' };
  }
  const bad = (t.match(/[�\u0000-\u0008\u000e-\u001f]/g) || []).length;
  if (bad / t.length > 0.01) return { ok: false, reason: 'The download looks garbled (binary or wrong encoding). Paste the text instead.' };
  return { ok: true };
}

export async function fetchPage(raw, { fetchImpl = fetch, resolve = lookup, timeoutMs = 20000 } = {}) {
  let target = raw;
  for (let hop = 0; hop < 5; hop++) {
    const checked = await checkUrl(target, { resolve });
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const res = await fetchImpl(checked.url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      target = new URL(res.headers.get('location'), checked.url).toString();
      continue;
    }
    // Some sites (Devpost, for one) answer 403 to non-browser clients yet still send the
    // full page. Keep the body and let the text check below decide; a real refusal page
    // is too thin to pass it.
    if (!res.ok && res.status !== 403) return { ok: false, reason: `The page answered HTTP ${res.status}.` };
    const type = res.headers.get('content-type') || '';
    if (/pdf/i.test(type)) return { ok: false, reason: 'That link is a PDF. Paste the rules text instead.' };
    const body = await res.text();
    if (body.length > MAX_BYTES) return { ok: false, reason: 'That page is too large to read.' };
    const isHtml = /html/i.test(type) || /^\s*</.test(body);
    const text = isHtml ? htmlToText(body) : body.trim();
    const quality = assessText(text);
    return { ok: quality.ok, reason: quality.reason, text, title: isHtml ? titleOf(body) : '', url: checked.url.toString() };
  }
  return { ok: false, reason: 'Too many redirects.' };
}
