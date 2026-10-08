import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyExtraction, toOpportunity } from '../src/agents/clerk.js';
import { buildDossier } from '../src/agents/profiler.js';
import { pickModel } from '../src/agents/llm.js';
import { checkUrl, htmlToText, assessText, fetchPage } from '../src/sources/fetchPage.js';
import { checkEligibility } from '../src/engine/eligibility.js';

const RULES = `Eligibility. Participation is strictly restricted to working professionals, entrepreneurs, and startups.
Full-time or part-time students are strictly ineligible. Teams may range from Two (2) participants up to four (4) members.
Every participant must be at least 21 years of age at the time of registration. Submissions are due 18 October 2026.`;

test('clerk keeps quoted claims and resets the ones it cannot quote', () => {
  const raw = {
    title: 'Example Cup', type: 'hackathon', students: 'excluded', region: 'global', team_min: 2, team_max: 4, age_min: 21,
    accepts_existing: 'yes', deadline: '2026-10-18',
    quotes: {
      students: 'Full-time or part-time students are strictly ineligible.',
      team: 'Teams may range from Two (2) participants up to four (4) members',
      age: 'must be at least 21 years of age',
      region: 'Open to participants from every country in the world.', // invented
      existing: 'Existing projects are welcome.', // invented
    },
  };
  const { out, quotes, unverified, stats } = verifyExtraction(raw, RULES);
  assert.equal(out.students, 'excluded');
  assert.equal(out.team_max, 4);
  assert.equal(out.region, 'unknown');
  assert.equal(out.accepts_existing, 'unknown');
  assert.equal(out.deadline, null, 'deadline had no quote at all');
  assert.deepEqual(unverified.map((u) => u.field).sort(), ['accepts_existing', 'deadline', 'region']);
  assert.equal(stats.claimed, 7);
  assert.equal(stats.verified, 4);
  assert.ok(quotes.students.verified);

  const opp = toOpportunity(out, { url: 'https://example.org/rules', today: '2026-10-06', quotes, unverified });
  const el = checkEligibility(opp, { codeStartedAt: '2026-10-06', team: [{ base: 'SG', pass: 'SC', employed: 'yes', student: 'no', age: '21' }] }, '2026-10-06');
  assert.equal(el.status, 'check', 'unquoted claims must surface as checks');
  assert.equal(el.reasons.filter((r) => r.code === 'unverified').length, 3);
  assert.equal(el.reasons.find((r) => r.code === 'students').quote, 'Full-time or part-time students are strictly ineligible.');
});

test('model picker prefers the newest stable Flash', () => {
  assert.equal(pickModel(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-001']), 'gemini-2.5-flash');
  assert.equal(pickModel(['gemini-3.1-flash', 'gemini-2.5-flash']), 'gemini-3.1-flash');
  assert.equal(pickModel(['gemini-3-flash-preview']), 'gemini-3-flash-preview');
  assert.equal(pickModel(['text-embedding-004']), null);
});

function fakeGitHub({ readme, oldest = '2026-08-23T10:00:00Z', created = '2026-09-07T04:21:00Z' }) {
  return async (url) => {
    const u = String(url);
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    if (u.endsWith('/repos/acme/widget')) return json({ name: 'widget', description: 'A widget', html_url: 'https://github.com/acme/widget', created_at: created, license: { spdx_id: 'Apache-2.0' }, stargazers_count: 12, topics: ['future-of-work'], language: 'TypeScript' });
    if (u.includes('/commits?per_page=1&page=7')) return json([{ sha: 'abc', commit: { author: { date: oldest }, committer: { date: oldest } } }]);
    if (u.includes('/commits?per_page=1')) return json([{ sha: 'zzz', commit: { author: { date: '2026-10-01T00:00:00Z' } } }], { link: '<https://api.github.com/repositories/1/commits?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?per_page=1&page=7>; rel="last"' });
    if (u.endsWith('/readme')) return new Response(readme, { status: 200 });
    return new Response('{}', { status: 404 });
  };
}

test('profiler dates the project by its first commit and keeps only quotable README facts', async () => {
  const readme = ['# Widget', 'Widget helps product teams plan sprints from their backlog and their calendar, then keeps the plan honest as work lands.',
    'It has 373 engine tests and runs in Singapore.', 'Plans are drafts until a person approves them; nothing is sent to your team without a click.',
    'Install with npm and point it at a GitHub project board to get started in a few minutes.'].join('\n');
  const llm = {
    async generate() {
      return {
        name: 'Widget', one_liner: 'Plans sprints',
        evidence: [
          { fact: '373 engine tests', quote: 'It has 373 engine tests and runs in Singapore.' },
          { fact: '10,000 users', quote: 'Widget is used by 10,000 teams.' }, // not in README
        ],
      };
    },
  };
  const r = await buildDossier({ repoUrl: 'https://github.com/acme/widget', llm, fetchImpl: fakeGitHub({ readme }) });
  assert.equal(r.dossier.codeStartedAt, '2026-08-23');
  assert.equal(r.dossier.repoCreatedAt, '2026-09-07');
  assert.equal(r.dropped, 1);
  assert.ok(r.dossier.evidence.some((e) => e.fact === '373 engine tests'));
  assert.ok(!r.dossier.evidence.some((e) => /10,000/.test(e.fact)));
  assert.ok(r.dossier.themes.includes('future of work'));
});

test('profiler works without AI: GitHub facts only', async () => {
  const r = await buildDossier({ repoUrl: 'github.com/acme/widget', llm: null, fetchImpl: fakeGitHub({ readme: 'short' }) });
  assert.equal(r.ai, false);
  assert.equal(r.dossier.codeStartedAt, '2026-08-23');
  assert.match(r.dossier.evidence[0].fact, /First commit on 2026-08-23/);
});

const publicDNS = async () => [{ address: '93.184.216.34', family: 4 }];

test('fetcher refuses private, loopback and metadata addresses', async () => {
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/computeMetadata/v1/', 'http://localhost:8080', 'http://metadata.google.internal/', 'file:///etc/passwd', 'http://[::1]/']) {
    assert.equal((await checkUrl(u, { resolve: publicDNS })).ok, false, u);
  }
  assert.equal((await checkUrl('https://rebind.example/', { resolve: async () => [{ address: '10.0.0.5', family: 4 }] })).ok, false);
  assert.equal((await checkUrl('https://example.org/rules', { resolve: publicDNS })).ok, true);
});

test('fetcher does not follow a redirect into a private address', async () => {
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
  const r = await fetchPage('https://example.org/go', { fetchImpl, resolve: publicDNS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not public/);
});

test('html to text drops scripts and keeps structure; thin or garbled pages are refused before any model call', () => {
  const t = htmlToText('<html><head><script>var x=1</script><style>p{}</style></head><body><h1>Rules</h1><p>Teams of 2&ndash;4.</p><ul><li>Age 21+</li></ul></body></html>');
  assert.match(t, /Rules\nTeams of 2–4\.\n- Age 21\+/);
  assert.ok(!/var x/.test(t));
  assert.equal(assessText('<div id="root">Loading…</div> Please enable JavaScript').ok, false);
  assert.equal(assessText('PK\u0003\u0004'.repeat(200) + '�'.repeat(50)).ok, false);
  assert.equal(assessText('word '.repeat(200)).ok, true);
});

test('a 403 that still carries the full page is read; a bare refusal is not', async () => {
  const rules = `<html><body><h1>Official Rules</h1><p>${'Projects must be either newly created by the Entrant or significantly updated. '.repeat(12)}</p></body></html>`;
  const full = await fetchPage('https://example.org/rules', { resolve: publicDNS, fetchImpl: async () => new Response(rules, { status: 403, headers: { 'content-type': 'text/html' } }) });
  assert.equal(full.ok, true);
  assert.match(full.text, /significantly updated/);
  const bare = await fetchPage('https://example.org/rules', { resolve: publicDNS, fetchImpl: async () => new Response('<h1>403 Forbidden</h1>', { status: 403, headers: { 'content-type': 'text/html' } }) });
  assert.equal(bare.ok, false);
  const gone = await fetchPage('https://example.org/rules', { resolve: publicDNS, fetchImpl: async () => new Response(rules, { status: 404, headers: { 'content-type': 'text/html' } }) });
  assert.equal(gone.ok, false);
});
