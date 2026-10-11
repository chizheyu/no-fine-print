// Clerk extraction eval: extract terms from each labelled snapshot, compare with gold.
//   npm run eval            (needs GEMINI_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT)
// The model reads the saved snapshots in eval/snapshots/ (public official pages, committed
// with the labels so anyone can check a label against the exact text the model saw); the
// eval never fetches live pages. Reports field accuracy, quote verification, traps passed,
// and "confident errors": wrong values that still came with a quote we could verify — the
// dangerous kind.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLLM } from '../src/agents/llm.js';
import { extractTerms } from '../src/agents/clerk.js';
import { FIELD, QUOTE_KEY, blank, matches } from './fields.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const gold = JSON.parse(await readFile(here('./gold.json'), 'utf8'));
const llm = createLLM(process.env);
if (!llm) {
  console.error('Set GEMINI_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT.');
  process.exit(2);
}

// Load every snapshot before spending a model call: a missing file is a broken gold set.
const events = [];
for (const ev of gold.events) {
  const text = await readFile(here(`./${ev.snapshot}`), 'utf8').catch(() => null);
  if (!text) {
    console.error(`${ev.id}: snapshot ${ev.snapshot} is missing. The eval only reads saved snapshots.`);
    process.exit(1);
  }
  events.push({ ev, text });
}

await mkdir(here('./results/'), { recursive: true });
const rows = [];
let total = 0; let correct = 0; let confident = 0; let claimed = 0; let verified = 0; let traps = 0; let trapsOk = 0; let failed = 0;

for (const { ev, text } of events) {
  // One retry for a transient failure; a second failure counts every field of the event as wrong.
  let result = null;
  let error = null;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try { result = await extractTerms({ text, url: ev.url, llm, today: gold.asOf }); error = null; } catch (e) { error = e; }
  }
  if (error) { failed += 1; console.error(`${ev.id}: extraction failed: ${error.message}`); }
  if (result) { claimed += result.stats.claimed; verified += result.stats.verified; }
  for (const [field, spec] of Object.entries(ev.expect)) {
    const value = result ? FIELD[field](result.opp) : undefined;
    const ok = Boolean(result) && matches(value, spec.accept);
    const quoted = Boolean(result?.opp.quotes[QUOTE_KEY[field]]);
    // A claim whose quote was not found in the snapshot is reset before it reaches the
    // engine; keep what the model said so a miss can be told apart from a reset.
    const reset = result?.opp.unverified.find((u) => u.field === field);
    total += 1; correct += ok ? 1 : 0;
    if (spec.trap) { traps += 1; trapsOk += ok ? 1 : 0; }
    if (!ok && quoted && !blank(value)) confident += 1;
    rows.push({
      event: ev.id, field, expected: JSON.stringify(spec.accept), got: result ? JSON.stringify(value) : `error: ${error.message}`,
      ok, quoted, trap: Boolean(spec.trap), ...(reset ? { resetFrom: reset.claimed, resetQuote: reset.quote } : {}),
    });
  }
}

console.table(rows);
const summary = {
  model: llm.model, backend: llm.backend, location: process.env.GOOGLE_CLOUD_LOCATION || null, asOf: gold.asOf, ranAt: new Date().toISOString(),
  events: events.length, failedEvents: failed,
  fieldAccuracy: `${correct}/${total}`, trapsPassed: `${trapsOk}/${traps}`, confidentErrors: confident,
  quotesVerified: `${verified}/${claimed}`, tokens: llm.usage,
};
console.log(summary);
// Date and time (UTC) in the name, so a second run on the same day keeps the first.
await writeFile(here(`./results/${summary.ranAt.slice(0, 16).replace(':', '')}-${llm.model}.json`), JSON.stringify({ summary, rows }, null, 1));
