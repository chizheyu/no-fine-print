import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { memoryStore } from '../src/store/index.js';

const RULES = `Official rules of the Example Cup. Participation is strictly restricted to working professionals.
Full-time or part-time students are strictly ineligible. Teams may range from Two (2) participants up to four (4) members.
Submissions close on 30 November 2026 at 23:59 SGT. All work must be created during the event.
Each team must submit a working prototype, a public repository and a video under three minutes. Judging weighs technical merit,
impact, originality and presentation equally. Prizes are paid in cash to the team's designated representative within 60 days.`;

// A grounded answer for the Investigator. Every name is made up.
const GROUNDED = `## Past editions
- The 2025 edition drew 900 registrants.
## Judges and sponsors
- Example Cloud sponsors the event.
## Employee exclusions
- None found.
## Contradictions
- CONFLICT: the prototype deadline
  - A: The terms say prototypes are due on October 4, 2026.
  - B: The microsite says prototypes are due on October 18, 2026.`;
const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';
const seg = (text, s, chunks) => {
  const at = text.indexOf(s);
  return { segment: { startIndex: Buffer.byteLength(text.slice(0, at)), endIndex: Buffer.byteLength(text.slice(0, at + s.length)), text: s }, groundingChunkIndices: chunks };
};
const GROUNDING = {
  webSearchQueries: ['Example Cup 2026 terms'],
  searchEntryPoint: { renderedContent: '<div class="container"><a class="chip" href="https://www.google.com/search?q=Example">Example</a></div>' },
  groundingChunks: [{ web: { uri: `${REDIRECT}A`, title: 'aibuildercup.com' } }, { web: { uri: `${REDIRECT}B`, title: 'news.example.com' } }],
  // "The 2025 edition drew 900 registrants." has no support.
  groundingSupports: [
    seg(GROUNDED, '- Example Cloud sponsors the event', [0]),
    seg(GROUNDED, '## Contradictions\n- CONFLICT: the prototype deadline\n  - A: The terms say prototypes are due on October 4, 2026', [1]),
    seg(GROUNDED, '- B: The microsite says prototypes are due on October 18, 2026', [0]),
  ],
};

// A complete seven-section kit; the first section carries the claims the guard must catch.
const KIT = ['## One-line pitch\nWe saved teams 40 hours [E1]. Built on Gemini [E9].', '## Title options (3)\nA; B; C',
  '## How we map to the judging criteria\n| Impact | [TODO: user numbers] | run a trial |', '## Submission text\nProblem and solution.',
  '## 3-minute demo script\n0:00 intro', '## Deliverables checklist\nVideo, deck, repo, live URL.', '## Risks and compliance\nFresh code only.'].join('\n\n');

// A stand-in for Gemini that answers by task, so the whole pipeline runs offline.
function fakeLLM() {
  return {
    backend: 'fake', model: 'fake-flash', usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, grounded: 0,
    async ground(o) {
      this.grounded += 1;
      o.meter?.(800);
      o.onText?.('## Past editions');
      return { text: GROUNDED, metadata: GROUNDING, pages: [], model: 'fake-flash' };
    },
    async generate(o) {
      o.meter?.(1000);
      if (o.prompt.includes('<rules>')) {
        return {
          title: 'Example Cup', type: 'hackathon', students: 'excluded', region: 'global', team_min: 2, team_max: 4,
          accepts_existing: 'no', deadline: '2026-11-30', prize_total: 10000, prize_currency: 'USD', cash: true,
          quotes: { deadline: 'Submissions close on 30 November 2026 at 23:59 SGT.', students: 'Full-time or part-time students are strictly ineligible.', team: 'Teams may range from Two (2) participants up to four (4) members.', region: 'Open worldwide.', existing: 'All work must be created during the event.' },
        };
      }
      if (o.prompt.includes('<dossier>')) return KIT;
      if (o.prompt.includes('<submission>')) return { scores: [{ criterion: 'Impact', score: 6, why: 'ok' }], overall: 6, verdict: 'Fine', fixes: ['a', 'b', 'c'] };
      throw new Error('unexpected prompt');
    },
  };
}

async function start(opts = {}) {
  const app = await createApp({
    store: memoryStore(), llm: fakeLLM(), today: () => '2026-10-06',
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response(`<html><body><p>${RULES}</p></body></html>`, { headers: { 'content-type': 'text/html' } }),
    ...opts,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  // Asks for progress lines (NDJSON) the way the web client does.
  const stream = async (path, body, who = 'a') => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', ...(jar[who] ? { cookie: jar[who] } : {}) },
      body: JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    const text = await res.text();
    const lines = /x-ndjson/.test(res.headers.get('content-type') || '') ? text.trim().split('\n').map((l) => JSON.parse(l)) : null;
    return { status: res.status, lines, body: lines ? null : JSON.parse(text) };
  };
  const call = async (path, body, who = 'a') => {
    const res = await fetch(base + path, {
      method: body ? (body.__method || 'POST') : 'GET',
      headers: { 'content-type': 'application/json', ...(jar[who] ? { cookie: jar[who] } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return { call, stream, close: () => server.close() };
}

const sample = JSON.parse(await readFile(new URL('../data/sample-dossier.json', import.meta.url), 'utf8'));
const cup = (results) => results.find((r) => r.opp.id === 'sg-aibuildercup-2026');

test('status and ranking: a part-time student knocks the whole team out of the AI Builder Cup', async () => {
  const { call, close } = await start();
  try {
    const s = await call('/api/status');
    assert.equal(s.body.ai.on, true);
    assert.ok(s.body.opportunities > 100);

    let r = await call('/api/rank', { dossier: sample });
    assert.equal(r.status, 200);
    const out = cup(r.body.results);
    assert.equal(out.elig.status, 'out');
    assert.match(out.elig.reasons.find((x) => x.code === 'students').quote, /part-time students are strictly ineligible/);

    const fixed = structuredClone(sample);
    fixed.team[2].student = 'no';
    r = await call('/api/rank', { dossier: fixed });
    assert.equal(cup(r.body.results).elig.status, 'ok');
  } finally { close(); }
});

test('extract → verify → rank: an unquotable claim becomes a check, and the event joins this session only', async () => {
  const { call, close } = await start();
  try {
    const x = await call('/api/opportunities/extract', { url: 'https://example.org/rules' });
    assert.equal(x.status, 200);
    assert.deepEqual(x.body.opp.unverified.map((u) => u.field), ['region']);
    assert.equal(x.body.opp.prize.total_sgd, 12900);

    const mine = (await call('/api/rank', { dossier: sample })).body.results.find((r) => r.opp.id === x.body.opp.id);
    assert.ok(mine, 'added event is ranked for its session');
    assert.ok(mine.elig.reasons.some((r) => r.code === 'unverified'));

    const theirs = (await call('/api/rank', { dossier: sample }, 'b')).body.results.find((r) => r.opp.id === x.body.opp.id);
    assert.equal(theirs, undefined, 'another session does not see it');
  } finally { close(); }
});

test('the kit guard flags numbers and citations the dossier cannot back', async () => {
  const { call, close } = await start();
  try {
    const k = await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' });
    assert.equal(k.status, 200);
    assert.deepEqual(k.body.audit.numbers, ['40']);
    assert.deepEqual(k.body.audit.citations, ['E9']);
    assert.equal(k.body.audit.ok, false);
  } finally { close(); }
});

test('fetching a metadata address through the API is refused', async () => {
  const { call, close } = await start({ resolve: async (h) => [{ address: h === 'evil.example' ? '169.254.169.254' : '93.184.216.34', family: 4 }] });
  try {
    const x = await call('/api/opportunities/extract', { url: 'http://evil.example/rules' });
    assert.equal(x.status, 400);
    assert.match(x.body.error.message, /not public/);
  } finally { close(); }
});

test('daily token budget per session', async () => {
  const { call, close } = await start({ env: { AI_DAILY_TOKENS: '1500' } });
  try {
    assert.equal((await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' })).status, 200);
    assert.equal((await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' })).status, 200);
    const third = await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'budget');
  } finally { close(); }
});

test('without AI the engine still ranks and AI routes say so', async () => {
  const { call, close } = await start({ llm: null });
  try {
    assert.equal((await call('/api/rank', { dossier: sample })).status, 200);
    const k = await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' });
    assert.equal(k.status, 503);
    assert.equal(k.body.error.code, 'ai_off');
  } finally { close(); }
});

test('dossiers are stored per session and sanitised', async () => {
  const { call, close } = await start();
  try {
    const saved = await call('/api/dossiers', { __method: 'PUT', dossier: { ...sample, name: 'x'.repeat(500), team: [{ pass: 'ROOT', role: 'r' }] } });
    assert.equal(saved.body.dossier.name.length, 120);
    assert.equal(saved.body.dossier.team[0].pass, 'UNK');
    assert.equal((await call('/api/dossiers')).body.dossiers.length, 1);
    assert.equal((await call('/api/dossiers', undefined, 'b')).body.dossiers.length, 0);
  } finally { close(); }
});

test('the whole deployment has one daily cap, and the rules engine is never rate limited', async () => {
  const { call, close } = await start({ env: { AI_GLOBAL_DAILY_TOKENS: '1500', AI_REQUESTS_PER_10_MIN: '2' } });
  try {
    assert.equal((await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' }, 'a')).status, 200);
    assert.equal((await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' }, 'b')).status, 200);
    const third = await call('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' }, 'c');
    assert.equal(third.status, 429, 'a fresh session does not get a fresh budget');
    for (let i = 0; i < 6; i++) assert.equal((await call('/api/rank', { dossier: sample }, 'a')).status, 200);
  } finally { close(); }
});

// Grounding cites pages through Google redirect links; the server looks each one up once.
const redirects = async (url, opts) => (String(url).startsWith(REDIRECT)
  ? new Response(null, { status: 302, headers: { location: String(url).endsWith('A') ? 'https://aibuildercup.com/faq' : 'https://news.example.com/cup' } })
  : new Response(`<html><body><p>${RULES}</p></body></html>`, { headers: { 'content-type': 'text/html' } }));

test('investigate streams its steps, then a card that never shows an unsupported sentence as fact', async () => {
  const llm = fakeLLM();
  const { stream, call, close } = await start({ llm, fetchImpl: redirects });
  try {
    const r = await stream('/api/investigate', { oppId: 'sg-aibuildercup-2026' });
    assert.equal(r.status, 200);
    const steps = r.lines.filter((l) => l.step).map((l) => l.step);
    assert.ok(steps.length >= 3, 'progress arrives before the result');
    assert.ok('result' in r.lines.at(-1), 'the result is the last line');
    assert.match(steps[0], /searching the web/);
    const { card, cached } = r.lines.at(-1).result;
    assert.equal(cached, false);
    assert.deepEqual(card.sections.find((s) => s.key === 'people').claims.map((c) => c.text), ['Example Cloud sponsors the event.']);
    assert.deepEqual(card.unsupported.map((u) => u.text), ['The 2025 edition drew 900 registrants.']);
    assert.equal(card.contradictions.length, 1);
    const [a, b] = card.contradictions[0].sides;
    assert.equal(card.sources[a.sources[0] - 1].url, 'https://news.example.com/cup');
    assert.equal(card.sources[b.sources[0] - 1].url, 'https://aibuildercup.com/faq');
    assert.equal(card.sources[b.sources[0] - 1].eventSite, true);
    assert.equal(card.contradictions[0].ownPages, false, 'side A rests on a news page');

    // The same event later today, from another session: no new search.
    const again = await call('/api/investigate', { oppId: 'sg-aibuildercup-2026' }, 'b');
    assert.equal(again.status, 200);
    assert.equal(again.body.cached, true);
    assert.equal(llm.grounded, 1);
    assert.equal((await call('/api/investigate', { oppId: 'no-such-event' })).status, 404);
  } finally { close(); }
});

test('investigations have their own daily caps, per session and for the deployment', async () => {
  const { call, close } = await start({ fetchImpl: redirects, env: { AI_SESSION_INVESTIGATIONS: '1', AI_DAILY_INVESTIGATIONS: '2' } });
  try {
    assert.equal((await call('/api/investigate', { oppId: 'sg-aibuildercup-2026' }, 'a')).status, 200);
    const mine = await call('/api/investigate', { oppId: 'devpost-paypal-ai-2026' }, 'a');
    assert.equal(mine.status, 429);
    assert.match(mine.body.error.message, /session/);
    assert.equal((await call('/api/investigate', { oppId: 'devpost-paypal-ai-2026' }, 'b')).status, 200);
    const all = await call('/api/investigate', { oppId: 'online-nebius-nvidia' }, 'c');
    assert.equal(all.status, 429);
    assert.equal(all.body.error.code, 'budget');
    assert.equal((await call('/api/investigate', { oppId: 'sg-aibuildercup-2026' }, 'c')).body.cached, true, 'cards made today still open');
  } finally { close(); }
  const off = await start({ llm: null });
  try { assert.equal((await off.call('/api/investigate', { oppId: 'sg-aibuildercup-2026' })).status, 503); } finally { off.close(); }
});

test('other long tasks report progress too; a failure after the first step arrives as an error line', async () => {
  const { stream, close } = await start();
  try {
    const k = await stream('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' });
    assert.deepEqual(k.lines.filter((l) => l.step).map((l) => l.step), ['Gemini is drafting the kit from your dossier and the rules.', 'Checking every number and citation against your dossier.']);
    assert.deepEqual(k.lines.at(-1).result.audit.numbers, ['40']);
    const x = await stream('/api/opportunities/extract', { url: 'https://example.org/rules' });
    assert.match(x.lines[0].step, /Fetching the rules page/);
    assert.equal(x.lines.at(-1).result.opp.title, 'Example Cup');
    // A refusal before any work starts is a plain HTTP error, even for a streaming client.
    const bad = await stream('/api/judge', { oppId: 'sg-aibuildercup-2026', kitText: 'short' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_input');
  } finally { close(); }
  const broken = await start({ llm: { ...fakeLLM(), generate: async () => { throw Object.assign(new Error('The model returned malformed JSON; try again.'), { code: 'bad_json' }); } } });
  try {
    const k = await broken.stream('/api/kit', { dossier: sample, oppId: 'sg-aibuildercup-2026' });
    assert.equal(k.status, 200, 'the stream had already started');
    assert.match(k.lines[0].step, /drafting/);
    assert.deepEqual(k.lines.at(-1), { error: { code: 'bad_json', message: 'The model returned malformed JSON; try again.' } });
  } finally { broken.close(); }
});
