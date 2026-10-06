// Clerk extraction eval: fetch each labelled rules page, extract, compare with gold.
//   npm run eval            (needs GEMINI_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT)
// Pages are cached in eval/cache/ (not committed: they are other people's documents).
// Reports field accuracy, quote verification, and "confident errors": wrong values
// that still came with a quote we could verify — the dangerous kind.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLLM } from '../src/agents/llm.js';
import { extractTerms } from '../src/agents/clerk.js';
import { fetchPage } from '../src/sources/fetchPage.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const gold = JSON.parse(await readFile(here('./gold.json'), 'utf8'));
const llm = createLLM(process.env);
if (!llm) {
  console.error('Set GEMINI_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT.');
  process.exit(2);
}

const FIELD = {
  students: (o) => o.elig.students, region: (o) => o.elig.region, team_min: (o) => o.elig.team_min, team_max: (o) => o.elig.team_max,
  age_min: (o) => o.elig.age_min, accepts_existing: (o) => o.accepts_existing, deadline: (o) => o.deadline, build_start: (o) => o.build_start,
  ip_first_refusal: (o) => o.ip_first_refusal, excludes_employees_of: (o) => o.elig.excludes_employees_of,
  excludes_judge_employers: (o) => o.elig.excludes_judge_employers,
};
const QUOTE_KEY = { students: 'students', region: 'region', team_min: 'team', team_max: 'team', age_min: 'age', accepts_existing: 'existing', deadline: 'deadline', build_start: 'build_start', ip_first_refusal: 'ip', excludes_employees_of: 'employees', excludes_judge_employers: 'employees' };

const blank = (v) => v == null || v === 0 || v === 'unknown' || v === '';
function matches(value, expected) {
  return expected.some((e) => {
    if (e === null) return blank(value);
    if (Array.isArray(e)) return Array.isArray(value) && value.length === e.length;
    if (typeof e === 'string' && e.startsWith('contains:')) return Array.isArray(value) && value.some((x) => String(x).toLowerCase().includes(e.slice(9)));
    return value === e;
  });
}

await mkdir(here('./cache/'), { recursive: true });
await mkdir(here('./results/'), { recursive: true });
const rows = [];
let total = 0; let correct = 0; let confident = 0; let claimed = 0; let verified = 0;

for (const ev of gold.events) {
  const cache = here(`./cache/${ev.id}.txt`);
  let text = await readFile(cache, 'utf8').catch(() => null);
  if (!text) {
    const page = await fetchPage(ev.url);
    if (!page.ok) { console.error(`${ev.id}: ${page.reason}`); continue; }
    text = page.text;
    await writeFile(cache, text);
  }
  const { opp, stats } = await extractTerms({ text, url: ev.url, llm, today: gold.asOf });
  claimed += stats.claimed; verified += stats.verified;
  for (const [field, expected] of Object.entries(ev.expect)) {
    const value = FIELD[field](opp);
    const ok = matches(value, expected);
    const quoted = Boolean(opp.quotes[QUOTE_KEY[field]]);
    total += 1; correct += ok ? 1 : 0;
    if (!ok && quoted && !blank(value)) confident += 1;
    rows.push({ event: ev.id, field, expected: JSON.stringify(expected), got: JSON.stringify(value), ok, quoted });
  }
}

console.table(rows);
const summary = {
  model: llm.model, backend: llm.backend, asOf: gold.asOf, ranAt: new Date().toISOString(),
  fieldAccuracy: `${correct}/${total}`, confidentErrors: confident,
  quotesVerified: `${verified}/${claimed}`, tokens: llm.usage,
};
console.log(summary);
await writeFile(here(`./results/${summary.ranAt.slice(0, 10)}-${llm.model}.json`), JSON.stringify({ summary, rows }, null, 1));
