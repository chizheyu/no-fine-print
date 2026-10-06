import test from 'node:test';
import assert from 'node:assert/strict';
import { periodDates, readRules } from '../src/sources/devpost.js';

test('submission periods parse, including year-crossing ones', () => {
  assert.deepEqual(periodDates('Aug 31 - Oct 23, 2026'), { start: '2026-08-31', end: '2026-10-23' });
  assert.deepEqual(periodDates('Oct 01 - 14, 2026'), { start: '2026-10-01', end: '2026-10-14' });
  assert.deepEqual(periodDates('Dec 15 - Jan 10, 2027'), { start: '2026-12-15', end: '2027-01-10' });
  assert.deepEqual(periodDates('Dec 01, 2026 - Jan 15, 2027'), { start: '2026-12-01', end: '2027-01-15' });
  assert.deepEqual(periodDates(''), { start: null, end: null });
});

test('standard Devpost rules: existing work, staff exclusions and sanctions clause, each with its sentence', () => {
  const text = [
    'Sponsor:', 'PayPal Inc., 2211 North First Street, San Jose, California 95131, United States',
    'The Hackathon IS open to:', 'Individuals who are at least the age of majority where they reside as of the time of entry.',
    'The Hackathon IS NOT open to:',
    'Individuals who are residents of a country which is comprehensively sanctioned by the U.S. Treasury.',
    'Employees, representatives and agents** of such Promotion Entities, and all members of their immediate family or household.',
    'Any Judge (defined below), or company or individual that employs a Judge.',
    'Projects must be either newly created by the Entrant or, if the Entrant’s Project existed prior to the Hackathon Submission Period, must have been significantly updated after the start of the Hackathon Submission Period.',
  ].join('\n');
  const r = readRules(text, 'https://x.devpost.com/rules');
  assert.equal(r.accepts_existing, 'partial');
  assert.equal(r.elig.region, 'global');
  assert.deepEqual(r.elig.excludes_employees_of, ['PayPal Inc.', 'Devpost']);
  assert.equal(r.elig.excludes_judge_employers, true);
  assert.equal(r.elig.age_min, 18);
  assert.match(r.quotes.existing.text, /significantly updated/);
});
