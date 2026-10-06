import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEligibility } from '../src/engine/eligibility.js';
import { sameCompany } from '../src/engine/companies.js';

const TODAY = '2026-10-06';
const member = (over = {}) => ({ role: 'Builder', base: 'SG', pass: 'SC', employed: 'yes', student: 'no', age: '21', employer: '', ...over });
const project = (over = {}) => ({ name: 't', stage: 'prototype', team: [member()], ...over });
const opp = (over = {}) => ({
  id: 'o', title: 'Test Hackathon', type: 'hackathon', organizer: 'Test Org', deadline: '2026-10-18', build_start: '2026-09-07',
  accepts_existing: 'no', elig: { students: 'open', region: 'global' }, prize: {}, ...over,
});
const by = (el, code) => el.reasons.filter((r) => r.code === code);

// The test for "existing work" is when the code was first written, not whether the
// product has launched (a lesson from misjudging a real project as "new").
test('prototype written before the build window is out', () => {
  const el = checkEligibility(opp(), project({ codeStartedAt: '2026-08-23' }), TODAY);
  assert.equal(el.status, 'out');
  assert.ok(by(el, 'existing').some((r) => r.level === 'out'));
});

test('project started inside the window is not out, even if already live', () => {
  const el = checkEligibility(opp(), project({ stage: 'live', codeStartedAt: '2026-09-10' }), TODAY);
  assert.ok(!by(el, 'existing').some((r) => r.level === 'out'));
});

test('missing first-commit date is a check, never a silent pass or a false out', () => {
  const el = checkEligibility(opp(), project({ stage: 'live' }), TODAY);
  const ex = by(el, 'existing');
  assert.ok(ex.some((r) => r.level === 'check'));
  assert.ok(!ex.some((r) => r.level === 'out'));
});

test('existing allowed with significant update: old code gets the update warning', () => {
  const el = checkEligibility(opp({ accepts_existing: 'partial', build_start: '2026-10-01' }), project({ codeStartedAt: '2026-08-23' }), TODAY);
  assert.ok(by(el, 'existing').some((r) => r.level === 'warn' && /significantly updated/.test(r.text)));
});

test('existing allowed with significant update: code started in window counts as new', () => {
  const el = checkEligibility(opp({ accepts_existing: 'partial', build_start: '2026-10-01' }), project({ codeStartedAt: '2026-10-02' }), TODAY);
  assert.ok(by(el, 'existing').some((r) => r.level === 'ok'));
});

// Sponsor staff. The AI Builder Cup terms have no employee clause, yet Google's own
// policy bars Googlers from competing for prizes. Silence in the rules is not a pass.
test('employee of the sponsor is flagged even when the rules are silent', () => {
  const o = opp({ title: 'Google Cloud AI Builder Cup 2026', organizer: 'Hack2skill', sponsors: ['Google Cloud'] });
  const el = checkEligibility(o, project({ codeStartedAt: '2026-10-06', team: [member({ employer: 'Google' })] }), TODAY);
  assert.equal(el.status, 'check');
  assert.ok(by(el, 'employer').some((r) => r.level === 'check' && /Google/.test(r.text)));
});

test('corporate families count: a DeepMind employee at a Kaggle competition', () => {
  const o = opp({ title: 'Kaggle Gemma Developer Challenge', organizer: 'Kaggle' });
  const el = checkEligibility(o, project({ team: [member({ employer: 'Google DeepMind' })] }), TODAY);
  assert.ok(by(el, 'employer').some((r) => r.level === 'check'));
});

test('explicit employee exclusion is out', () => {
  const o = opp({ title: 'Build, Ship, Shape', organizer: 'Devpost', elig: { students: 'open', region: 'global', excludes_employees_of: ['Amazon'] } });
  const el = checkEligibility(o, project({ codeStartedAt: '2026-10-06', team: [member({ employer: 'AWS' })] }), TODAY);
  assert.equal(el.status, 'out');
});

test('"company that employs a judge" clause is out when the rules have it', () => {
  const o = opp({ judge_companies: ['PayPal', 'Elastic'], elig: { students: 'open', region: 'global', excludes_judge_employers: true } });
  const el = checkEligibility(o, project({ codeStartedAt: '2026-10-06', team: [member({ employer: 'Elastic N.V.' })] }), TODAY);
  assert.ok(by(el, 'employer').some((r) => r.level === 'out' && /judge/.test(r.text)));
});

test('employer that sets a problem statement gets a warning', () => {
  const o = opp({ fixed_problems: true, tracks: [{ name: 'Banking Track - DBS' }, { name: 'Healthcare Track - NTU' }] });
  const el = checkEligibility(o, project({ codeStartedAt: '2026-10-06', team: [member({ employer: 'DBS Bank' })] }), TODAY);
  assert.ok(by(el, 'employer').some((r) => r.level === 'warn' && /problem statements/.test(r.text)));
});

test('company matching does not fire on look-alike names', () => {
  assert.equal(sameCompany('Metabase', 'Meta VR Start Developer Competition'), false);
  assert.equal(sameCompany('Open Government Products', 'OpenAI Build Week'), false);
  assert.equal(sameCompany('Googleplex Catering', 'Hack2skill'), false);
  assert.equal(sameCompany('Google', 'Google Cloud AI Builder Cup 2026'), true);
  assert.equal(sameCompany('AWS', 'Amazon'), true);
});

test('students and professionals', () => {
  const pro = opp({ elig: { students: 'excluded', region: 'japac' } });
  assert.equal(checkEligibility(pro, project({ codeStartedAt: '2026-10-06', team: [member(), member({ student: 'yes' })] }), TODAY).status, 'out');
  assert.equal(checkEligibility(pro, project({ codeStartedAt: '2026-10-06', team: [member(), member({ employed: 'unk' })] }), TODAY).status, 'check');
  assert.equal(checkEligibility(pro, project({ codeStartedAt: '2026-10-06', team: [member(), member()] }), TODAY).status, 'ok');
});

test('team size, age and closed deadlines', () => {
  const o = opp({ deadline: '2026-10-01', elig: { students: 'open', region: 'global', team_min: 2, team_max: 4, age_min: 21 } });
  const el = checkEligibility(o, project({ codeStartedAt: '2026-10-06', team: [member({ age: '18' })] }), TODAY);
  assert.ok(by(el, 'deadline').some((r) => r.level === 'out'));
  assert.ok(by(el, 'team').some((r) => r.level === 'check' && /1 more/.test(r.text)));
  assert.ok(by(el, 'age').some((r) => r.level === 'out'));
});

test('work pass holder and a cash prize: warned, never called allowed', () => {
  const o = opp({ accepts_existing: 'yes', prize: { cash: true } });
  const el = checkEligibility(o, project({ team: [member({ pass: 'EP', prPending: true }), member({ pass: 'PR' })] }), TODAY);
  const w = by(el, 'work_pass');
  assert.equal(w.length, 1);
  assert.equal(w[0].level, 'warn');
  assert.match(w[0].text, /no published guidance/);
  assert.match(w[0].text, /never route it through a teammate/);
});

test('a claim the extractor could not quote becomes a check', () => {
  const o = opp({ accepts_existing: 'yes', unverified: [{ field: 'students', claimed: 'students only' }] });
  const el = checkEligibility(o, project(), TODAY);
  assert.equal(el.status, 'check');
  assert.ok(by(el, 'unverified').length === 1);
});

test('reasons carry the clause they came from', () => {
  const quote = 'Pre-existing products, ongoing projects, or code developed prior to the official launch will be disqualified.';
  const o = opp({ url: 'https://example.org/rules', quotes: { existing: { text: quote } } });
  const r = by(checkEligibility(o, project({ codeStartedAt: '2026-08-23' }), TODAY), 'existing')[0];
  assert.equal(r.quote, quote);
  assert.equal(r.url, 'https://example.org/rules');
});
