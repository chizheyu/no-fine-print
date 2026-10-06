// Scout for Devpost. Lists open hackathons from Devpost's public API, then reads each
// rules page and pulls the clauses that decide eligibility with plain patterns (no
// model). Each value keeps the sentence it came from, so it can be shown and checked.

import { htmlToText } from './fetchPage.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// "Aug 31 - Oct 23, 2026" | "Dec 01, 2026 - Jan 15, 2027" | "Oct 01 - 14, 2026"
export function periodDates(period) {
  const p = String(period || '').trim();
  const end = p.match(/-\s*(?:([A-Za-z]{3})\w*\s+)?(\d{1,2}),\s*(\d{4})\s*$/);
  const start = p.match(/^([A-Za-z]{3})\w*\s+(\d{1,2})(?:,\s*(\d{4}))?/);
  if (!end || !start) return { start: null, end: null };
  const endMonth = MONTHS[(end[1] || start[1]).toLowerCase()];
  const endYear = Number(end[3]);
  const startMonth = MONTHS[start[1].toLowerCase()];
  if (!endMonth || !startMonth) return { start: null, end: null };
  let startYear = start[3] ? Number(start[3]) : endYear;
  if (!start[3] && (startMonth > endMonth || (startMonth === endMonth && Number(start[2]) > Number(end[2])))) startYear -= 1;
  return { start: iso(startYear, startMonth, Number(start[2])), end: iso(endYear, endMonth, Number(end[2])) };
}

const RULES = {
  existingNo: /(newly created|must be (?:new|created|started|built) (?:during|after|within)|created (?:during|after) the (?:start|hackathon|submission period)|new projects only|pre-?existing[^.]{0,80}(?:not eligible|disqualif|not (?:be )?(?:accepted|permitted|allowed)))/i,
  existingYes: /(existing projects? (?:are|is) welcome|you may submit an existing|existing (?:startups?|products?|projects?) (?:are|is) eligible)/i,
  existingPartial: /(significantly (?:updated|modified|improved)|existed prior to the (?:hackathon )?submission period|existing (?:project|app|application|work)s?[^.]{0,80}(?:may|can|are allowed|is allowed|eligible))/i,
  age: /(age of majority|at least (\d{2}) years|(\d{2}) years of age or older|over the age of (\d{2}))/i,
  studentsOnly: /(must be (?:a |an )?(?:currently )?enrolled|students? only|open (?:only )?to (?:university |college |high school )?students)/i,
  sanctions: /comprehensively sanctioned|office of foreign assets control/i,
  residentsOnly: /(?:only open to|open only to|limited to)\s+(?:legal\s+)?residents of\s+([A-Z][\w ,]+)/,
  promotionStaff: /employees, representatives and agents[^.]{0,40}promotion entities/i,
  judgeEmployers: /company or individual that employs a judge/i,
};

export function sentences(text) {
  return String(text).split(/(?<=[.;:])\s+(?=[A-Z(])|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function readRules(text, url) {
  const out = { accepts_existing: 'unknown', elig: {}, quotes: {}, sponsors: [] };
  const q = (key, s) => { if (!out.quotes[key]) out.quotes[key] = { text: s.slice(0, 400), url, verified: true }; };
  const sponsor = String(text).match(/Sponsor:\s*\n?\s*([^,\n]+)/);
  if (sponsor) out.sponsors.push(sponsor[1].trim());
  for (const s of sentences(text)) {
    if (out.accepts_existing === 'unknown') {
      if (RULES.existingYes.test(s)) { out.accepts_existing = 'yes'; q('existing', s); }
      else if (RULES.existingPartial.test(s)) { out.accepts_existing = 'partial'; q('existing', s); }
      else if (RULES.existingNo.test(s)) { out.accepts_existing = 'no'; q('existing', s); }
    }
    const age = s.match(RULES.age);
    if (age && !out.elig.age_min) { out.elig.age_min = Number(age.slice(2).find(Boolean)) || 18; q('age', s); }
    if (RULES.studentsOnly.test(s) && !out.elig.students) { out.elig.students = 'only'; q('students', s); }
    const only = s.match(RULES.residentsOnly);
    if (only && !out.elig.region) { out.elig.region = 'unknown'; q('region', s); }
    if (RULES.sanctions.test(s) && !out.elig.region) { out.elig.region = 'global'; q('region', s); }
    if (RULES.promotionStaff.test(s) && out.sponsors.length) { out.elig.excludes_employees_of = [...out.sponsors, 'Devpost']; q('employees', s); }
    if (RULES.judgeEmployers.test(s)) { out.elig.excludes_judge_employers = true; q('employees', s); }
  }
  return out;
}

const money = (s) => { const m = String(s || '').replace(/<[^>]+>/g, '').match(/([\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, '')) : null; };

export function toOpportunity(h, rules, today, usdToSgd = 1.29) {
  const { start, end } = periodDates(h.submission_period_dates);
  const usd = money(h.prize_amount);
  const online = (h.displayed_location?.location || '') === 'Online';
  return {
    id: `devpost-${h.id}`,
    title: h.title,
    type: 'hackathon',
    organizer: h.organization_name || '',
    sponsors: rules?.sponsors || [],
    platform: 'Devpost',
    url: h.url,
    checked: today,
    provenance: 'scan',
    deadline: end,
    build_start: start,
    format: online ? 'online' : (h.displayed_location?.location || null),
    elig: {
      students: rules?.elig.students || 'unknown',
      region: rules?.elig.region || 'unknown',
      age_min: rules?.elig.age_min || null,
      team_min: null,
      team_max: null,
      excludes_employees_of: rules?.elig.excludes_employees_of || [],
      excludes_judge_employers: Boolean(rules?.elig.excludes_judge_employers),
    },
    accepts_existing: rules?.accepts_existing || 'unknown',
    fixed_problems: false,
    required_tech: null,
    themes: (h.themes || []).map((t) => String(t.name || '').toLowerCase()).filter(Boolean),
    tracks: [],
    judging: [],
    prize: { total_sgd: usd ? Math.round(usd * usdToSgd) : null, top_sgd: null, awards: h.prizes_counts?.cash ?? null, cash: Boolean(h.prizes_counts?.cash) },
    registrants: h.registrations_count ?? null,
    registrants_checked: today,
    quotes: rules?.quotes || {},
  };
}

export async function scanDevpost({ fetchImpl = fetch, today, readRulePages = true, pause = 400, log = () => {} }) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const list = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`https://devpost.com/api/hackathons?status%5B%5D=open&page=${page}`, { headers });
    if (!res.ok) throw new Error(`Devpost list answered HTTP ${res.status}`);
    const d = await res.json();
    const batch = d.hackathons || [];
    list.push(...batch);
    if (!batch.length || list.length >= (d.meta?.total_count || 0)) break;
  }
  const out = [];
  for (const h of list.filter((x) => !x.invite_only)) {
    let rules = null;
    if (readRulePages) {
      const rulesUrl = `${String(h.url).replace(/\/$/, '')}/rules`;
      try {
        const res = await fetchImpl(rulesUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
        if (res.ok) rules = readRules(htmlToText(await res.text()), rulesUrl);
      } catch (e) { log(`rules page failed for ${h.url}: ${e.message}`); }
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
    out.push(toOpportunity(h, rules, today));
  }
  return out;
}
