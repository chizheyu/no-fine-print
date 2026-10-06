import test from 'node:test';
import assert from 'node:assert/strict';
import { numbersNotIn, badCitations, uncitedClaims, bannedPhrases, audit } from '../src/engine/guards.js';
import { verifyQuote } from '../src/quotes.js';

const dossier = 'Arena ranks 91 competitions. 85 of them had an eligibility condition we could not determine. 6 engine tests pass.';

test('numbers not in the dossier are flagged; dates, years and list markers are not', () => {
  const draft = '1. We analysed 91 competitions [E1] and saved users 40 hours on 2026-10-05.\nBuilt in 2026 by a team of 2.';
  assert.deepEqual(numbersNotIn(draft, dossier), ['40']);
});

test('numbers with thousands separators match the dossier written without them', () => {
  assert.deepEqual(numbersNotIn('About 20,621 registrants.', 'registrants: 20621'), []);
  assert.deepEqual(numbersNotIn('A 10k pool.', 'pool of 10,000'), []);
});

test('a number is only backed by the same kind of number', () => {
  // "40%" (a judging weight) must not back "40 hours" (a claim), and vice versa.
  assert.deepEqual(numbersNotIn('We saved teams 40 hours.', 'Technical merit 40%'), ['40']);
  assert.deepEqual(numbersNotIn('Technical merit is 40% of the score.', 'Technical merit 40%'), []);
  assert.deepEqual(numbersNotIn('Accuracy rose to 85%.', 'We checked 85 events.'), ['85%']);
  assert.deepEqual(numbersNotIn('Version 10 ships today.', 'Released 2026-10-06 at https://x.org/v10'), ['10']);
});

test('citations must point at evidence that exists', () => {
  assert.deepEqual(badCitations('Fact [E1]. Another [E4]. Third [E0].', 3), ['E4', 'E0']);
});

test('sentences with numbers but no citation are listed; headings and TODOs are skipped', () => {
  const t = '## Impact in 3 steps\nWe cut research time by 70%. Our engine has 6 tests [E3].\nUsers: [TODO: real numbers after trial 2].';
  assert.deepEqual(uncitedClaims(t), ['We cut research time by 70%.']);
});

test('banned phrases are flagged unless the dossier backs them', () => {
  assert.deepEqual(bannedPhrases('This guarantees you will win the prize.'), ['promises an outcome']);
  assert.deepEqual(bannedPhrases('An award-winning team.', 'Won first place, an award-winning entry.'), []);
});

test('audit passes clean text', () => {
  const r = audit('Arena checked 91 competitions [E1].', { dossierText: dossier, evidenceCount: 3 });
  assert.equal(r.ok, true);
});

test('quotes: exact, typographic and elided matches; inventions fail', () => {
  const src = 'Teams may range from Two (2) participants up to four (4) members during the virtual building phase. Students are “strictly ineligible”.';
  assert.equal(verifyQuote('Teams may range from Two (2) participants up to four (4) members', src).ok, true);
  assert.equal(verifyQuote('Students are "strictly ineligible"', src).ok, true);
  assert.equal(verifyQuote('Teams may range from Two (2) participants ... during the virtual building phase', src).ok, true);
  assert.equal(verifyQuote('Teams may range from one to five members', src).ok, false);
  assert.equal(verifyQuote('Two', src).ok, false);
});
