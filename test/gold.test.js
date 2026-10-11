import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyQuote } from '../src/quotes.js';
import { assessText } from '../src/sources/fetchPage.js';
import { FIELD, matches } from '../eval/fields.js';

// The eval is only as good as its labels. Every label must be checkable against the exact
// text the model reads: each quote has to appear verbatim in the saved snapshot (no "..."
// elisions), and a label the page does not support has to say why.

const evalDir = (p) => fileURLToPath(new URL(`../eval/${p}`, import.meta.url));
const gold = JSON.parse(readFileSync(evalDir('gold.json'), 'utf8'));
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const labels = gold.events.flatMap((ev) => Object.entries(ev.expect).map(([field, spec]) => ({ ev, field, spec })));

test('every event has a saved English snapshot with real rules text', () => {
  assert.ok(gold.events.length >= 5);
  assert.equal(new Set(gold.events.map((e) => e.id)).size, gold.events.length, 'event ids are unique');
  for (const ev of gold.events) {
    assert.match(ev.snapshot, /^snapshots\/[\w-]+\.txt$/, ev.id);
    assert.ok(existsSync(evalDir(ev.snapshot)), `${ev.id}: ${ev.snapshot} is missing`);
    const text = readFileSync(evalDir(ev.snapshot), 'utf8');
    assert.ok(text.length > 5000 && assessText(text).ok, `${ev.id}: snapshot is too thin to label`);
    assert.ok(!CJK.test(text), `${ev.id}: snapshot has non-English text`);
    assert.match(ev.fetched, /^\d{4}-\d{2}-\d{2}$/, ev.id);
    assert.match(ev.url, /^https:\/\//, ev.id);
    assert.ok(Object.keys(ev.expect).length >= 1, `${ev.id}: no labelled fields`);
  }
});

test('every quote behind a label is in its snapshot, word for word', () => {
  let n = 0;
  for (const { ev, field, spec } of labels) {
    const text = readFileSync(evalDir(ev.snapshot), 'utf8');
    for (const q of spec.quotes || []) {
      const r = verifyQuote(q, text);
      assert.equal(r.method, 'exact', `${ev.id}.${field}: quote not found verbatim: "${q.slice(0, 80)}"`);
      n += 1;
    }
  }
  assert.ok(n >= labels.length, 'most labels carry at least one quote');
});

test('every label is readable by the eval and justified by a quote or a reason', () => {
  for (const { ev, field, spec } of labels) {
    const where = `${ev.id}.${field}`;
    assert.ok(FIELD[field], `${where}: the eval cannot read this field`);
    assert.ok(Array.isArray(spec.accept) && spec.accept.length, `${where}: needs a non-empty "accept" list`);
    assert.ok(spec.quotes?.length || spec.why?.trim(), `${where}: needs "quotes" or a "why" note`);
    if (spec.accept.every((a) => a === null)) assert.ok(spec.why?.trim(), `${where}: an "unknown" label needs a "why" note`);
  }
});

test('the set keeps traps where the right answer is "unknown"', () => {
  const unknownTraps = labels.filter(({ spec }) => spec.trap && spec.accept.every((a) => a === null));
  assert.ok(unknownTraps.length >= 2, `only ${unknownTraps.length} unknown traps`);
  // A trap must not accept the answer a guesser would give.
  assert.equal(matches(18, labels.find((l) => l.ev.id === 'build-with-ai-basics-2026' && l.field === 'age_min').spec.accept), false);
  assert.equal(matches('2026-10-18', labels.find((l) => l.ev.id === 'google-ai-builder-cup-2026' && l.field === 'deadline').spec.accept), false);
});

test('label matching: unknowns, empty lists and "contains:"', () => {
  assert.equal(matches(null, [null]), true);
  assert.equal(matches('unknown', [null]), true);
  assert.equal(matches(0, [null]), true);
  assert.equal(matches(1, [null]), false);
  assert.equal(matches(false, [false]), true);
  assert.equal(matches(true, [false]), false);
  assert.equal(matches([], [[]]), true);
  assert.equal(matches(['Google'], [[]]), false);
  assert.equal(matches(['PayPal Inc.', 'Devpost'], ['contains:paypal']), true);
  assert.equal(matches(['Devpost'], ['contains:paypal']), false);
});
