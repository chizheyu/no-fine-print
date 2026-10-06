// Ranking: eligible first, then fit, then expected prize per entry, then the
// nearest deadline. Prize pools alone mislead: a US$30k pool shared by 20,000
// registrants is worth less per entry than a US$5k pool shared by 200.

import { checkEligibility } from './eligibility.js';
import { daysBetween } from './dates.js';

export const COMPETE_TYPES = ['hackathon', 'competition', 'challenge', 'award'];

export function fmtSGD(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n >= 10) return String(Math.round(n));
  return n.toFixed(2);
}

export function expectedValue(opp) {
  const pr = opp.prize || {};
  const total = pr.total_sgd || null;
  const n = opp.registrants || null;
  if (total && n) {
    return {
      perEntry: total / n,
      text: `about S$${fmtSGD(total / n)} per registrant`,
      basis: `S$${fmtSGD(total)} pool ÷ ${n.toLocaleString('en-US')} registrants${opp.registrants_checked ? ` (counted ${opp.registrants_checked})` : ''}`,
    };
  }
  if (total) return { perEntry: null, text: `S$${fmtSGD(total)} pool`, basis: 'registrant count unknown' };
  if (pr.top_sgd) return { perEntry: null, text: `top prize S$${fmtSGD(pr.top_sgd)}`, basis: 'pool and registrant count unknown' };
  return { perEntry: null, text: 'prize unknown', basis: '' };
}

const VOCAB = [
  ['ai', 'artificial intelligence'], ['agent', 'agents', 'agentic', 'multi-agent'], ['llm', 'genai', 'generative', 'gemini', 'gpt'],
  ['career', 'jobs', 'job', 'employment', 'hiring', 'recruit', 'talent', 'hr'], ['future of work', 'reskilling', 'upskilling', 'workforce'],
  ['education', 'learning', 'student', 'edtech'], ['fintech', 'finance', 'banking', 'payments', 'payment'], ['health', 'healthcare', 'medical'],
  ['social impact', 'social good', 'for good', 'community', 'nonprofit', 'accessibility'], ['productivity', 'workflow', 'automation', 'enterprise'],
  ['open source'], ['google cloud', 'vertex', 'firebase', 'cloud run'], ['aws', 'bedrock'], ['nvidia', 'gpu'], ['vr', 'xr', 'quest'],
  ['data', 'analytics'], ['security', 'cyber', 'privacy'], ['sustainability', 'climate', 'green'], ['government', 'civic', 'public sector', 'govtech'],
  ['real estate', 'property'], ['mobility', 'transport'], ['eldercare', 'ageing', 'aging', 'dementia'], ['legal', 'compliance', 'regulation', 'eligibility'],
];
const VOCAB_RE = VOCAB.map((group) => group.map((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.+]/g, '\\$&')}(s)?($|[^a-z0-9])`, 'i')));

function topicsOf(text) {
  const t = String(text || '').toLowerCase();
  const hit = new Set();
  VOCAB_RE.forEach((group, i) => { if (group.some((re) => re.test(t))) hit.add(VOCAB[i][0]); });
  return hit;
}

export function themeOverlap(opp, project) {
  if (!project) return { n: 0, words: [] };
  const a = topicsOf([project.oneLiner, project.description, (project.themes || []).join(' '), (project.techStack || []).join(' ')].join(' '));
  const tracks = (opp.tracks || []).map((t) => (typeof t === 'string' ? t : `${t.name || ''} ${t.desc || ''}`)).join(' ');
  const b = topicsOf([opp.title, (opp.themes || []).join(' '), tracks, opp.required_tech, opp.organizer].join(' '));
  const words = [...a].filter((w) => b.has(w));
  return { n: words.length, words };
}

export function rankOpportunities(opps, project, today, opts = {}) {
  const order = { ok: 0, check: 1, out: 2 };
  return opps
    .filter((o) => opts.allTypes || COMPETE_TYPES.includes(o.type))
    .map((o) => ({
      opp: o,
      elig: checkEligibility(o, project, today),
      ev: expectedValue(o),
      overlap: themeOverlap(o, project),
      days: o.deadline ? daysBetween(today, o.deadline) : null,
    }))
    .filter((x) => x.days === null || x.days >= 0 || opts.keepPast)
    .sort((a, b) => (order[a.elig.status] - order[b.elig.status])
      || (b.overlap.n - a.overlap.n)
      || ((b.ev.perEntry || 0) - (a.ev.perEntry || 0))
      || ((a.days ?? 9999) - (b.days ?? 9999)));
}
