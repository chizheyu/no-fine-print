// Input from the browser is untrusted: trim it to known fields, known values and sane sizes.

const str = (v, max) => String(v ?? '').slice(0, max);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const list = (v, maxItems, maxLen) => (Array.isArray(v) ? v.slice(0, maxItems).map((x) => str(x, maxLen)).filter(Boolean) : []);
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export const BASES = ['SG', 'JAPAC', 'CN', 'OTHER', 'UNK'];
export const PASSES = ['SC', 'PR', 'EP', 'SP', 'DP', 'LTVP', 'STP', 'OTHER', 'UNK'];

export function cleanMember(m = {}) {
  return {
    role: str(m.role, 60),
    base: pick(m.base, BASES, 'UNK'),
    pass: pick(m.pass, PASSES, 'UNK'),
    employed: pick(m.employed, ['yes', 'no', 'unk'], 'unk'),
    student: pick(m.student, ['yes', 'no', 'unk'], 'unk'),
    age: pick(m.age, ['21', '18', 'u18', 'unk'], 'unk'),
    employer: str(m.employer, 80),
    prPending: Boolean(m.prPending),
  };
}

export function cleanDossier(d = {}) {
  return {
    id: typeof d.id === 'string' && /^[\w-]{1,64}$/.test(d.id) ? d.id : undefined,
    name: str(d.name, 120) || 'Untitled project',
    oneLiner: str(d.oneLiner, 300),
    description: str(d.description, 3000),
    stage: pick(d.stage, ['idea', 'prototype', 'live', 'users', 'revenue'], 'prototype'),
    themes: list(d.themes, 20, 60),
    techStack: list(d.techStack, 20, 60),
    links: list(d.links, 5, 300).filter((u) => /^https?:\/\//.test(u)),
    codeStartedAt: date(d.codeStartedAt),
    repoCreatedAt: date(d.repoCreatedAt),
    evidence: (Array.isArray(d.evidence) ? d.evidence : []).slice(0, 40).map((e) => ({
      fact: str(e?.fact, 400), source: str(e?.source, 80), quote: e?.quote ? str(e.quote, 600) : undefined, verified: Boolean(e?.verified),
    })).filter((e) => e.fact),
    team: (Array.isArray(d.team) ? d.team : []).slice(0, 6).map(cleanMember),
  };
}

export function cleanBet(b = {}) {
  const p = Number(b.pWin);
  return {
    id: typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : undefined,
    oppId: str(b.oppId, 120),
    oppTitle: str(b.oppTitle, 200),
    dossierName: str(b.dossierName, 120),
    pWin: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0,
    hours: Math.max(0, Math.min(2000, Number(b.hours) || 0)),
    why: str(b.why, 1000),
    outcome: pick(b.outcome, ['', 'win', 'finalist', 'lost', 'withdrawn'], ''),
    at: str(b.at, 40) || new Date().toISOString(),
  };
}
