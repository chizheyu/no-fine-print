import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOpportunities, expectedValue } from '../src/engine/ranking.js';

const TODAY = '2026-10-06';
const team = [{ role: 'Builder', base: 'SG', pass: 'SC', employed: 'yes', student: 'no', age: '21' }];
const project = { name: 'p', oneLiner: 'AI agents for the future of work', codeStartedAt: '2026-10-06', team };
const base = { type: 'hackathon', accepts_existing: 'yes', elig: { students: 'open', region: 'global' } };

test('expected value is per registrant, not pool size', () => {
  const big = expectedValue({ prize: { total_sgd: 38700 }, registrants: 20621 });
  const small = expectedValue({ prize: { total_sgd: 6450 }, registrants: 200 });
  assert.ok(small.perEntry > big.perEntry);
  assert.match(big.text, /per registrant/);
});

test('eligible events come first, closed events are dropped', () => {
  const opps = [
    { ...base, id: 'out', title: 'Students only', elig: { students: 'only', region: 'global' }, deadline: '2026-11-01' },
    { ...base, id: 'ok', title: 'Open AI agents cup', deadline: '2026-11-01' },
    { ...base, id: 'past', title: 'Closed', deadline: '2026-09-01' },
    { ...base, id: 'check', title: 'Mystery', deadline: '2026-11-01', elig: {} },
  ];
  const ids = rankOpportunities(opps, project, TODAY).map((x) => x.opp.id);
  assert.deepEqual(ids, ['ok', 'check', 'out']);
});

test('grants and programmes are left out unless asked for', () => {
  const opps = [{ ...base, id: 'g', type: 'grant', deadline: '2026-11-01' }];
  assert.equal(rankOpportunities(opps, project, TODAY).length, 0);
  assert.equal(rankOpportunities(opps, project, TODAY, { allTypes: true }).length, 1);
});

test('scans refresh registrant counts on hand-checked seeds and replace scan-sourced seeds', async () => {
  const { mergeSources } = await import('../src/app.js');
  const seeds = [
    { id: 'a', url: 'https://a.devpost.com/', provenance: 'official', accepts_existing: 'partial', registrants: 100 },
    { id: 'b', url: 'https://b.devpost.com', provenance: 'platform-api', accepts_existing: 'unknown', registrants: 50 },
  ];
  const scanned = [
    { id: 'devpost-1', url: 'https://a.devpost.com', accepts_existing: 'unknown', registrants: 180, registrants_checked: '2026-10-07' },
    { id: 'devpost-2', url: 'https://b.devpost.com/rules', accepts_existing: 'no', registrants: 90 },
    { id: 'devpost-3', url: 'https://c.devpost.com', registrants: 5 },
  ];
  const out = mergeSources(seeds, scanned);
  assert.deepEqual(out.map((o) => o.id), ['a', 'b', 'devpost-3']);
  assert.equal(out[0].accepts_existing, 'partial');
  assert.equal(out[0].registrants, 180);
  assert.equal(out[1].accepts_existing, 'no');
});
