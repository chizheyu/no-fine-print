// Output guards. Every generated draft passes through these before a person sees it.
// They catch the two ways an application overclaims: a number that isn't in the
// dossier, and a factual sentence that cites no evidence (or cites evidence that
// doesn't exist).

const lc = (s) => String(s ?? '').toLowerCase();

const strip = (s) => String(s || '')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/\[E\d+\]/g, ' ')
  .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
  .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
const NUM = /(?<![\w.,-])(\d[\d,]*(?:\.\d+)?)\s*(%|percent\b|k\b|x\b)?(?![\d-])/gi;
const kindOf = (unit) => (/%|percent/i.test(unit || '') ? 'pct' : 'num');

// Numbers in `text` that the `source` does not state. Matching is by whole number
// and by kind: "40 hours" is not backed by a "40%" judging weight elsewhere in the
// source (substring matching let exactly that through).
export function numbersNotIn(text, source) {
  const have = new Map();
  for (const m of strip(source).matchAll(NUM)) {
    const v = m[1].replace(/,/g, '');
    const values = /^k$/i.test(m[2] || '') ? [v, String(Number(v) * 1000)] : [v];
    values.forEach((x) => { if (!have.has(x)) have.set(x, new Set()); have.get(x).add(kindOf(m[2])); });
  }
  const body = strip(text)
    .replace(/\d+\s*[-–~]\s*\d+\s*(s\b|sec|min)/g, ' ')
    .replace(/\d+\s*(sec\b|min\b|s\b)/g, ' ')
    .replace(/^\s*\d+[.)]\s/gm, ' ');
  const seen = new Set();
  const out = [];
  for (const m of body.matchAll(NUM)) {
    const raw = m[1].replace(/,/g, '');
    const unit = m[2] || '';
    if (raw.length < 2 && !unit) continue;
    if (/^20\d\d$/.test(raw)) continue;
    const kind = kindOf(unit);
    const value = /^k$/i.test(unit) ? String(Number(raw) * 1000) : raw;
    if (have.get(raw)?.has(kind) || have.get(value)?.has(kind)) continue;
    const label = m[1] + unit;
    if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

// Citations like [E3] must point at an evidence entry that exists.
export function badCitations(text, evidenceCount) {
  const bad = new Set();
  for (const m of String(text || '').matchAll(/\[E(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > evidenceCount) bad.add(`E${n}`);
  }
  return [...bad];
}

// Sentences that state a number (a claim you could check) without citing evidence.
// Headings, table rows and [TODO] placeholders are skipped.
export function uncitedClaims(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith('|') || /\[TODO/i.test(l)) continue;
    for (const s of l.split(/(?<=[.!?])\s+/)) {
      if (/\d/.test(s.replace(/\[E\d+\]/g, '')) && !/\[E\d+\]/.test(s) && !/\b\d{1,2}:\d{2}\b/.test(s)) out.push(s.slice(0, 160));
    }
  }
  return out;
}

const BANNED = [
  [/\bguarantee(d|s)?\b[^.]{0,40}\b(win|prize|success|funding)/i, 'promises an outcome'],
  [/\b100\s*%\s*(chance|success|accura)/i, 'claims certainty'],
  [/\baward[- ]winning\b/i, 'claims awards (only allowed if the dossier says so)'],
  [/\b(thousands|millions) of (users|customers)\b/i, 'claims a user base'],
];

export function bannedPhrases(text, dossierText = '') {
  const src = lc(dossierText);
  return BANNED.filter(([re]) => re.test(text) && !re.test(src)).map(([, why]) => why);
}

export function audit(text, { dossierText = '', evidenceCount = 0 } = {}) {
  const numbers = numbersNotIn(text, dossierText);
  const citations = badCitations(text, evidenceCount);
  const uncited = uncitedClaims(text);
  const phrases = bannedPhrases(text, dossierText);
  return { ok: !numbers.length && !citations.length && !phrases.length, numbers, citations, uncited, phrases };
}
