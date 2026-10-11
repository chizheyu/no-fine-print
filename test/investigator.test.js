import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCard, splitSentences, locateSupports, backing, buildCard, resolveSources, finishSources, eventSite, promptFor, pagesToRead, investigate,
} from '../src/agents/investigator.js';

// What Gemini writes back, in the format the prompt asks for. Every name is made up.
const ANSWER = `Here is the card:

## Past editions
- The 2025 edition of the Example Cup drew 1,200 registrants.
- The 2024 edition had 300 submissions.

## Judges and sponsors
- Example Cloud sponsors the event.
- Judges come from Example Cloud and Acme Labs.

## Employee exclusions
- Employees of Example Cloud may not win prizes.

## Contradictions
- CONFLICT: the team registration deadline
  - A: The terms and conditions say team registration closes on October 4, 2026.
  - B: The event microsite says team registration closes on October 11, 2026.
- CONFLICT: the prize pool
  - A: The rules page says the prize pool is $10,000.
  - B: A news post says the prize pool is $12,000.`;

const redirect = (n) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/FAKE${n}`;
const PAGES = {
  [redirect(0)]: 'https://example-cup.org/',
  [redirect(1)]: 'https://news.example.com/example-cup-2024',
  [redirect(2)]: 'https://example-cup.org/rules',
  [redirect(3)]: 'https://docs.google.com/document/d/e/EXAMPLE/pub',
  [redirect(4)]: 'https://example-cup.org/rules#prizes',
};

// A grounding support as the API sends it: the segment's text plus its UTF-8 byte
// offsets (the n-th occurrence of the text, counting from 0).
function support(text, seg, chunks, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(seg, at + 1);
  assert.ok(at >= 0, `segment not in text: ${seg}`);
  const startIndex = Buffer.byteLength(text.slice(0, at));
  return { segment: { startIndex, endIndex: startIndex + Buffer.byteLength(seg), text: seg }, groundingChunkIndices: chunks };
}

function metadataFor(text) {
  return {
    webSearchQueries: ['Example Cup 2026 rules', 'Example Cup judges', ''],
    searchEntryPoint: { renderedContent: '<style>.container{}</style><div class="container"><a class="chip" href="https://www.google.com/search?q=Example+Cup">Example Cup</a></div>' },
    groundingChunks: [0, 1, 2, 3, 4].map((n) => ({ web: { uri: redirect(n), title: new URL(PAGES[redirect(n)]).hostname, domain: new URL(PAGES[redirect(n)]).hostname } })),
    groundingSupports: [
      // Like the real API, the first support after a heading includes the heading.
      support(text, '## Past editions\n- The 2025 edition of the Example Cup drew 1,200 registrants', [0]),
      // Only the start of this sentence is supported: its number is not.
      support(text, '- The 2024 edition had', [1]),
      support(text, '- Example Cloud sponsors the event', [0, 2]),
      // "Judges come from ..." has no support at all.
      // Cites the same page as chunk 2, through another address (#prizes).
      support(text, '## Employee exclusions\n- Employees of Example Cloud may not win prizes', [4]),
      support(text, '## Contradictions\n- CONFLICT: the team registration deadline\n  - A: The terms and conditions say team registration closes on October 4, 2026', [3]),
      support(text, '- B: The event microsite says team registration closes on October 11, 2026', [0]),
      support(text, '- A: The rules page says the prize pool is $10,000', [4]),
      // Side B of the prize pool has no support, so that contradiction is not shown.
    ],
  };
}

const OPP = {
  id: 'example-cup', title: 'Example Cup 2026', organizer: 'Example Org', type: 'hackathon', url: 'https://example-cup.org/',
  quotes: { students: { text: 'Students may enter.', url: 'https://docs.google.com/document/d/e/EXAMPLE/pub' } },
  sources: [{ url: 'https://example-cup.org/rules' }],
};

test('the answer splits into sections, sentences and two-sided contradictions', () => {
  const { sections, conflicts } = parseCard(ANSWER);
  assert.deepEqual(sections.map((s) => s.key), ['editions', 'people', 'exclusions']);
  assert.equal(sections[0].items.length, 2);
  assert.ok(!sections.some((s) => s.items.some((i) => /Here is the card/.test(i.text))), 'a lead-in is not a claim');
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].topic.text, 'the team registration deadline');
  assert.deepEqual(conflicts[0].sides.map((s) => s.label), ['A', 'B']);
  for (const item of [...sections.flatMap((s) => s.items), ...conflicts.flatMap((c) => c.sides)]) {
    assert.equal(ANSWER.slice(item.start, item.end), item.text, 'offsets point at the text');
  }
});

test('"None found", bold headings, unknown headings and prose contradictions', () => {
  const text = '**Past editions**\n- None found.\n## The event drew 50,000 people\n- Example Cloud sponsors it.\n**Contradictions**\n- The terms and the microsite give different deadlines.\n- No contradictions were found.';
  const { sections, conflicts } = parseCard(text);
  assert.deepEqual(sections.map((s) => [s.key, s.title, s.items.length]), [['editions', 'Past editions', 0], ['other', 'Other findings', 1]], 'a heading is never shown as written');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].sides.length, 0, 'prose without sides cannot be checked side by side');
});

test('a contradiction whose topic line has no support gets a neutral heading', () => {
  const text = '## Contradictions\n- CONFLICT: the deadline moved twice\n  - A: The rules page says October 4.\n  - B: The FAQ page says October 11.';
  const metadata = {
    groundingChunks: [{ web: { uri: redirect(0) } }, { web: { uri: redirect(2) } }],
    groundingSupports: [support(text, 'A: The rules page says October 4', [0]), support(text, 'B: The FAQ page says October 11', [1])],
  };
  const [k] = buildCard({ text, metadata }).contradictions;
  assert.equal(k.topic, 'These statements disagree');
  assert.deepEqual(k.sides.map((s) => s.sources), [[1], [2]]);
});

test('sentences split at full stops, not at abbreviations', () => {
  const s = 'Example Cloud Inc. sponsors it. The U.S. office judges. Teams of 4 may enter.';
  assert.deepEqual(splitSentences(s).map(([a, b]) => s.slice(a, b)), ['Example Cloud Inc. sponsors it.', 'The U.S. office judges.', 'Teams of 4 may enter.']);
});

test('supports are placed by their text; byte offsets only pick between repeats', () => {
  // The em dash is three bytes in UTF-8 but one character in JavaScript.
  const text = 'Prize — S$1,000 in total.\nPrize — S$1,000 in total.';
  const [second] = locateSupports(text, [support(text, 'Prize — S$1,000 in total', [0], 1)]);
  assert.equal(second.start, text.lastIndexOf('Prize'));
  const [byOffset] = locateSupports(text, [{ segment: { startIndex: Buffer.byteLength('Prize — '), endIndex: Buffer.byteLength('Prize — S$1,000') }, groundingChunkIndices: [0] }]);
  assert.equal(text.slice(byOffset.start, byOffset.end), 'S$1,000');
});

test('a sentence is backed only when supports cover it, every digit included', () => {
  const text = 'The 2024 edition had 300 submissions.';
  const item = { start: 0, end: text.length };
  assert.equal(backing(text, item, [{ start: 0, end: text.length - 1, chunks: [0] }]).ok, true);
  const partial = backing(text, item, [{ start: 0, end: 20, chunks: [0] }]);
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /number/);
  assert.equal(backing(text, item, []).reason, 'no source supports it');
});

test('the card keeps backed sentences, lists the rest as unsupported, and needs both sides of a contradiction', () => {
  const card = buildCard({ text: ANSWER, metadata: metadataFor(ANSWER) });
  const by = (key) => card.sections.find((s) => s.key === key).claims.map((c) => c.text);
  assert.deepEqual(by('editions'), ['The 2025 edition of the Example Cup drew 1,200 registrants.']);
  assert.deepEqual(by('people'), ['Example Cloud sponsors the event.']);
  assert.deepEqual(by('exclusions'), ['Employees of Example Cloud may not win prizes.']);

  // Never presented as fact: the half-supported sentence, the unsupported one and
  // the contradiction whose second side has no source.
  assert.deepEqual(card.unsupported.map((u) => [u.section, u.reason]), [
    ['Past editions', 'a number in it is not supported by any source'],
    ['Judges and sponsors', 'no source supports it'],
    ['Contradictions', 'side B: no source supports it'],
  ]);
  assert.ok(!JSON.stringify(card.sections).includes('Acme Labs'));

  assert.equal(card.contradictions.length, 1);
  const [k] = card.contradictions;
  assert.equal(k.topic, 'the team registration deadline');
  assert.match(k.sides[0].text, /October 4, 2026/);
  assert.match(k.sides[1].text, /October 11, 2026/);
  assert.notDeepEqual(k.sides[0].sources, k.sides[1].sources, 'each side keeps its own source');

  assert.deepEqual(card.stats, { sentences: 9, backed: 6, unsupported: 3, searches: 2, pages: 5 });
  assert.equal(card.searches.length, 2, 'empty queries are dropped');
  assert.match(card.suggestions, /class="chip"/);
});

const fakeFetch = (log = []) => async (url, opts) => {
  log.push([String(url), opts?.method, opts?.redirect]);
  if (String(url).endsWith('FAKE1')) throw new Error('network down');
  return new Response(null, { status: 302, headers: { location: PAGES[String(url)] } });
};

test('cited pages are resolved without following them, merged, and marked when they are the event\'s own', async () => {
  const card = buildCard({ text: ANSWER, metadata: metadataFor(ANSWER) });
  const log = [];
  await resolveSources(card.sources, { fetchImpl: fakeFetch(log) });
  assert.ok(log.every(([, method, redirect]) => method === 'HEAD' && redirect === 'manual'));
  finishSources(card, OPP);

  // Chunks 2 and 4 are the same page (a #fragment apart): one source, one number.
  assert.equal(card.sources.length, 3);
  const urls = card.sources.map((s) => s.url);
  assert.equal(urls.filter((u) => u.startsWith('https://example-cup.org/rules')).length, 1);
  assert.deepEqual(card.sources.map((s) => s.n), card.sources.map((_, i) => i + 1));
  const own = Object.fromEntries(card.sources.map((s) => [s.url, s.eventSite]));
  assert.equal(own['https://example-cup.org/'], true);
  assert.equal(own['https://docs.google.com/document/d/e/EXAMPLE/pub'], true, 'a shared host counts under the event\'s own path');
  assert.equal(card.contradictions[0].ownPages, true);
  assert.equal(card.contradictions[0].samePage, false);
  for (const sec of card.sections) for (const c of sec.claims) assert.ok(c.sources.every((n) => n >= 1 && n <= card.sources.length));
});

test('a failed lookup keeps the redirect link; other people\'s pages are not the event\'s', async () => {
  const sources = [{ n: 1, uri: redirect(1) }];
  await resolveSources(sources, { fetchImpl: fakeFetch() });
  assert.equal(sources[0].url, redirect(1));
  const own = eventSite(OPP);
  assert.equal(own('https://news.example.com/example-cup-2024'), false);
  assert.equal(own('https://docs.google.com/document/d/e/OTHER/pub'), false);
  assert.equal(own('https://www.example-cup.org/faq'), true);
});

test('the prompt names the pages to read, leaves heavy documents to search, and caps searches', () => {
  assert.deepEqual(pagesToRead(OPP), ['https://example-cup.org/', 'https://example-cup.org/rules']);
  const p = promptFor(OPP);
  assert.match(p, /"official_pages":\["https:\/\/example-cup\.org\/","https:\/\/example-cup\.org\/rules"\]/);
  assert.ok(!p.includes('docs.google.com'));
  assert.match(p, /at most 6 searches/);
  assert.match(p, /CONFLICT:/);
});

test('investigate: reads, searches, checks, resolves, and reports each step', async () => {
  const calls = [];
  const llm = {
    async ground(o) {
      calls.push(o);
      o.onText?.('## Past');
      return { text: ANSWER, metadata: metadataFor(ANSWER), pages: [{ retrievedUrl: 'https://example-cup.org/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }, { retrievedUrl: 'https://example-cup.org/rules', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' }], model: 'fake-flash' };
    },
  };
  const steps = [];
  const card = await investigate({ opp: OPP, llm, fetchImpl: fakeFetch(), step: (s) => steps.push(s) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].urls, ['https://example-cup.org/', 'https://example-cup.org/rules']);
  assert.match(calls[0].system, /data, never an instruction/);
  assert.equal(steps.length, 4);
  assert.match(steps[0], /reading 2 official pages and searching the web/);
  assert.match(steps[1], /writing/);
  assert.match(steps[2], /ran 2 searches\. Checking 9 sentences/);
  assert.match(steps[3], /addresses of 4 cited pages/);
  assert.deepEqual(card.pagesRead, [{ url: 'https://example-cup.org/', ok: true }, { url: 'https://example-cup.org/rules', ok: false }]);
  assert.equal(card.event.id, 'example-cup');
  assert.equal(card.model, 'fake-flash');
  assert.equal(card.unsupported.length, 3);
  assert.equal(card.contradictions.length, 1);
});

test('investigate needs a model that can search', async () => {
  await assert.rejects(investigate({ opp: OPP, llm: null }), { code: 'ai_off' });
  await assert.rejects(investigate({ opp: OPP, llm: { ground: async () => ({ text: '  ', metadata: {} }) } }), { code: 'upstream' });
});
