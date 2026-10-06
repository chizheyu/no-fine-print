// Verbatim-quote verification. When a model says "the rules state X", X has to be
// findable in the text we actually fetched. Matching tolerates typography (curly
// quotes, dashes, whitespace, case) and "..." elisions, nothing else.

export function normText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

const trimEnds = (s) => s.replace(/^[\s"'.,;:()[\]-]+|[\s"'.,;:()[\]-]+$/g, '');

export function verifyQuote(quote, source) {
  const q = trimEnds(normText(quote));
  const src = normText(source);
  if (q.length < 8) return { ok: false, reason: 'too short to verify' };
  if (src.includes(q)) return { ok: true, method: 'exact' };
  const parts = q.split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/).map(trimEnds).filter((p) => p.length >= 8);
  if (parts.length > 1) {
    let from = 0;
    for (const p of parts) {
      const at = src.indexOf(p, from);
      if (at < 0) return { ok: false, reason: 'an elided segment was not found' };
      from = at + p.length;
    }
    return { ok: true, method: 'segments' };
  }
  return { ok: false, reason: 'not found in source' };
}
