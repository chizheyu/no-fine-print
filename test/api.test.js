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

// A stand-in for Gemini that answers by task, so the whole pipeline runs offline.
function fakeLLM() {
  return {
    backend: 'fake', model: 'fake-flash', usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    async generate(o) {
      o.meter?.(1000);
      if (o.prompt.includes('<rules>')) {
        return {
          title: 'Example Cup', type: 'hackathon', students: 'excluded', region: 'global', team_min: 2, team_max: 4,
          accepts_existing: 'no', deadline: '2026-11-30', prize_total: 10000, prize_currency: 'USD', cash: true,
          quotes: { deadline: 'Submissions close on 30 November 2026 at 23:59 SGT.', students: 'Full-time or part-time students are strictly ineligible.', team: 'Teams may range from Two (2) participants up to four (4) members.', region: 'Open worldwide.', existing: 'All work must be created during the event.' },
        };
      }
      if (o.prompt.includes('<dossier>')) return '## One-line pitch\nWe saved teams 40 hours [E1]. Built on Gemini [E9].\n'.padEnd(300, ' ');
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
  return { call, close: () => server.close() };
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
