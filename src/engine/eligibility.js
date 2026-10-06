// Eligibility as code. No LLM in this file: every verdict is a rule you can read,
// and every rule points back to the clause it came from when we have the quote.
//
// Levels: ok (passes), warn (eligible, but read this), check (we can't tell — verify
// before building), out (disqualifying). The event's status is the worst level found.

import { daysBetween } from './dates.js';
import { sameCompany } from './companies.js';

export const WORK_PASSES = ['EP', 'SP', 'DP', 'LTVP', 'STP', 'OTHER'];
export const PASS_NAMES = {
  SC: 'Singapore citizen', PR: 'Singapore PR', EP: 'Employment Pass', SP: 'S Pass', DP: "Dependant's Pass",
  LTVP: 'LTVP', STP: "Student's Pass", OTHER: 'other work pass', UNK: 'unknown',
};
const LEVEL_ORDER = { ok: 0, warn: 1, check: 2, out: 3 };

const isWorkPass = (p) => WORK_PASSES.includes(p);
const who = (m, i) => m.role || `Member ${i + 1}`;

export function checkEligibility(opp, project, today) {
  const reasons = [];
  const e = opp.elig || {};
  const q = opp.quotes || {};
  const team = project?.team || [];
  const add = (level, code, text, quoteKey) => {
    const r = { level, code, text };
    const quote = quoteKey && q[quoteKey];
    if (quote?.text) Object.assign(r, { quote: quote.text, url: quote.url || opp.url || null });
    reasons.push(r);
  };

  // Deadline
  if (opp.deadline) {
    const d = daysBetween(today, opp.deadline);
    if (d < 0) add('out', 'deadline', `Closed on ${opp.deadline}.`, 'deadline');
    else add('ok', 'deadline', `${d} day${d === 1 ? '' : 's'} left (deadline ${opp.deadline}).`, 'deadline');
  } else {
    add('check', 'deadline', 'Deadline not found in the rules.', 'deadline');
  }
  if (!team.length) add('check', 'team', 'No team members in the dossier yet, so every member rule is unknown.');

  // Students vs working professionals
  switch (e.students) {
    case 'only':
      if (team.length && team.every((m) => m.student === 'yes')) add('ok', 'students', 'Students only: every member is a student.', 'students');
      else if (team.some((m) => m.student === 'no')) add('out', 'students', 'Students only, and at least one member is not a student.', 'students');
      else add('check', 'students', 'Students only: student status not filled in.', 'students');
      break;
    case 'excluded':
      if (team.some((m) => m.student === 'yes')) add('out', 'students', 'Working professionals only: students (full- or part-time) are not eligible.', 'students');
      else if (team.some((m) => m.employed === 'no')) add('out', 'students', 'Working professionals only: a member is not employed.', 'students');
      else if (team.length && team.every((m) => m.employed === 'yes')) add('ok', 'students', 'Working professionals only: every member is employed.', 'students');
      else add('check', 'students', 'Working professionals only: employment status not filled in.', 'students');
      break;
    case 'prize_only':
      if (team.some((m) => m.student !== 'yes')) add('warn', 'students', 'Non-students can take part but cannot win prizes.', 'students');
      break;
    case 'some_member':
      add('check', 'students', 'At least one member must be a current student or recent graduate.', 'students');
      break;
    default:
      break;
  }

  // Residency and citizenship
  switch (e.region) {
    case 'sg_school':
      if (team.length && team.every((m) => m.student === 'yes' && m.base === 'SG')) add('ok', 'region', 'Singapore institutions only: every member qualifies.', 'region');
      else if (team.some((m) => m.student === 'no' || (m.base && !['SG', 'UNK'].includes(m.base)))) add('out', 'region', 'Only students of Singapore institutions can enter.', 'region');
      else add('check', 'region', 'Singapore institutions only: student status or location not filled in.', 'region');
      break;
    case 'sg_scpr':
      if (team.some((m) => m.pass === 'SC' || m.pass === 'PR')) add('ok', 'region', 'Citizens/PRs only: a citizen or PR member can be the applicant.', 'region');
      else if (team.length && team.every((m) => m.pass && m.pass !== 'UNK')) add('out', 'region', 'Singapore citizens and PRs only.', 'region');
      else add('check', 'region', 'Singapore citizens and PRs only: residency status not filled in.', 'region');
      break;
    case 'japac':
      if (team.some((m) => m.base === 'OTHER')) add('check', 'region', 'Must be based in Japan & Asia-Pacific: a member is outside the region.', 'region');
      else if (team.some((m) => m.base === 'CN')) add('check', 'region', 'Must be based in Japan & Asia-Pacific: the rules do not say whether mainland China counts.', 'region');
      else if (team.length && team.every((m) => m.base === 'SG' || m.base === 'JAPAC')) add('ok', 'region', 'Must be legal residents of Japan & Asia-Pacific: every member is.', 'region');
      else add('check', 'region', 'Must be based in Japan & Asia-Pacific: location not filled in.', 'region');
      break;
    case 'sg':
      if (team.length && team.every((m) => m.base === 'SG')) add('ok', 'region', 'Singapore-based teams: every member is in Singapore.', 'region');
      else add('check', 'region', 'Singapore-based teams: check whether members outside Singapore can join.', 'region');
      break;
    case 'global':
      if (e.excludes_cn && team.some((m) => m.base === 'CN')) add('out', 'region', 'The rules exclude residents of mainland China.', 'region');
      else add('ok', 'region', 'Open worldwide (sanctioned countries aside).', 'region');
      break;
    case 'commonwealth':
      if (team.some((m) => m.base === 'CN')) add('check', 'region', 'Commonwealth countries only: mainland China is not one.', 'region');
      else add('ok', 'region', 'Commonwealth countries only: Singapore is one.', 'region');
      break;
    default:
      add('check', 'region', 'Residency rules not found.', 'region');
  }

  // Team size and age
  if (e.team_max && team.length > e.team_max) add('out', 'team', `Teams of at most ${e.team_max}; you have ${team.length}.`, 'team');
  if (e.team_min && team.length < e.team_min) add('check', 'team', `Needs at least ${e.team_min} members: ${e.team_min - team.length} more to go.`, 'team');
  if (e.age_min) {
    if (team.some((m) => m.age === 'u18' || (e.age_min >= 21 && m.age === '18'))) add('out', 'age', `Every member must be at least ${e.age_min}.`, 'age');
    else if (team.some((m) => !m.age || m.age === 'unk')) add('check', 'age', `Every member must be at least ${e.age_min}: age not filled in.`, 'age');
  }

  // Existing work. The test is when the code was first written, not whether the
  // product has launched: a prototype written before the build window is still
  // "pre-existing", and a project started inside the window still counts as new.
  const cs = project?.codeStartedAt;
  const bs = opp.build_start;
  const before = cs && bs ? cs < bs : null;
  switch (opp.accepts_existing) {
    case 'no':
      if (before === true) add('out', 'existing', `New work only: your first commit (${cs}) predates the build window (${bs}). Start a new repository for a new project.`, 'existing');
      else if (before === false) add('warn', 'existing', `New work only: your first commit (${cs}) is inside the build window (${bs}). Continuing an earlier idea can still count as an ongoing project; confirm before submitting.`, 'existing');
      else if (!cs) add('check', 'existing', 'New work only: add the date of your first commit to the dossier.', 'existing');
      else add('check', 'existing', 'New work only: the start of the build window was not found.', 'existing');
      break;
    case 'partial':
      if (before === true) add('warn', 'existing', `Existing projects must be significantly updated during the event (first commit ${cs}, window opens ${bs}). Say what you added.`, 'existing');
      else if (before === false) add('ok', 'existing', `Your first commit (${cs}) is inside the build window, so this counts as new work.`, 'existing');
      else add('warn', 'existing', 'Existing projects are allowed if significantly updated during the event; judges look at what is new.', 'existing');
      break;
    case 'yes':
      add('ok', 'existing', 'Existing projects are accepted.', 'existing');
      break;
    default:
      if (before === true) add('check', 'existing', 'The rules do not say whether existing projects are accepted, and your code predates the build window.', 'existing');
      else if (before === null && (cs || (project?.stage && project.stage !== 'idea'))) add('check', 'existing', 'The rules do not say whether existing projects are accepted.', 'existing');
  }

  // Employers. Explicit exclusions are disqualifying. Sponsors usually bar their own
  // staff and their affiliates even when the event's terms are silent (a Googler
  // can't compete for prizes at a Google Cloud hackathon), so a match on the
  // organiser, a sponsor or the event's own name is flagged for checking.
  team.forEach((m, i) => {
    if (!m.employer) return;
    const explicit = (e.excludes_employees_of || []).find((x) => sameCompany(m.employer, x));
    if (explicit) {
      add('out', 'employer', `${who(m, i)} works for ${m.employer}; the rules exclude employees of ${explicit}.`, 'employees');
      return;
    }
    const judgeCo = (opp.judge_companies || []).find((x) => sameCompany(m.employer, x));
    if (judgeCo && e.excludes_judge_employers) {
      add('out', 'employer', `${who(m, i)} works for ${m.employer}; the rules exclude any company that employs a judge (${judgeCo}).`, 'employees');
      return;
    }
    const backer = [opp.organizer, ...(opp.sponsors || []), opp.title].find((x) => sameCompany(m.employer, x));
    if (backer) {
      add('check', 'employer', `${who(m, i)} works for ${m.employer}, which is behind this event (${backer}). Sponsors usually bar their own staff from competing even when the rules are silent; check your employer's policy.`);
    } else if (judgeCo) {
      add('warn', 'employer', `${who(m, i)}'s employer (${m.employer}) employs one of the judges; check the conflict-of-interest rules.`);
    }
    const track = (opp.tracks || []).map((t) => (typeof t === 'string' ? t : t.name || '')).find((t) => sameCompany(m.employer, t));
    if (track) add('warn', 'employer', `${who(m, i)}'s employer sets one of the problem statements (${track}); pick another track or clear it with your employer.`);
  });

  // Fixed problems, required tech, IP
  if (opp.fixed_problems) {
    const n = (opp.tracks || []).length;
    add('warn', 'tracks', `Fixed problem statements${n ? ` (${n})` : ''} and no open track: your project has to solve one of them.`);
  }
  if (opp.required_tech) add('warn', 'tech', `Must use: ${String(opp.required_tech).slice(0, 140)}`, 'tech');
  if (opp.ip_first_refusal || /right of first refusal|exclusive licen/i.test(opp.ip || '')) {
    add('warn', 'ip', 'IP: the organiser gets a right of first refusal on your work; read it before you try to sell or license the project.', 'ip');
  }

  // Singapore work passes. MOM has no published guidance on pass holders winning
  // cash prizes, so we never call it allowed; we say what is known and what is not.
  const passHolders = team.filter((m) => isWorkPass(m.pass));
  if (opp.work_pass_ok === 'no' && passHolders.length) {
    add('check', 'work_pass', 'Our records say work pass holders cannot enter (usually because the event is for students or citizens); check the rules.');
  }
  if (opp.prize?.cash && passHolders.length) {
    const pending = passHolders.some((m) => m.prPending);
    add('warn', 'work_pass', `${pending ? 'A member on a work pass with a PR application pending' : 'Work pass holders on the team'}: Singapore's Ministry of Manpower has no published guidance on pass holders winning cash prizes. Consider waiving that member's share in writing${pending ? ', and never route it through a teammate' : ''}.`);
  }

  // Fields the extractor claimed but could not back with a verbatim quote.
  (opp.unverified || []).forEach((u) => {
    add('check', 'unverified', `The rules may say "${u.claimed}" about ${u.field}, but that quote was not found in the source text. Read the clause yourself.`);
  });

  const status = reasons.reduce((worst, r) => (LEVEL_ORDER[r.level] > LEVEL_ORDER[worst] ? r.level : worst), 'ok');
  return { status: status === 'warn' ? 'ok' : status, reasons };
}
