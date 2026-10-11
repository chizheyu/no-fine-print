// How the eval reads a labelled field off an extracted opportunity, which quote key backs
// it, and how an answer is compared with the gold label. Shared by eval/run.js and the
// gold-set test, so a label for a field the eval cannot read fails in `npm test`.

export const FIELD = {
  students: (o) => o.elig.students, region: (o) => o.elig.region, excludes_cn: (o) => o.elig.excludes_cn,
  team_min: (o) => o.elig.team_min, team_max: (o) => o.elig.team_max, age_min: (o) => o.elig.age_min,
  accepts_existing: (o) => o.accepts_existing, deadline: (o) => o.deadline, build_start: (o) => o.build_start,
  ip_first_refusal: (o) => o.ip_first_refusal, excludes_employees_of: (o) => o.elig.excludes_employees_of,
  excludes_judge_employers: (o) => o.elig.excludes_judge_employers,
};

export const QUOTE_KEY = {
  students: 'students', region: 'region', excludes_cn: 'region', team_min: 'team', team_max: 'team', age_min: 'age',
  accepts_existing: 'existing', deadline: 'deadline', build_start: 'build_start', ip_first_refusal: 'ip',
  excludes_employees_of: 'employees', excludes_judge_employers: 'judge_employers',
};

export const blank = (v) => v == null || v === 0 || v === 'unknown' || v === '';

// `expected` lists every acceptable answer: null = not stated, [] = an empty list,
// "contains:x" = a list with an entry containing x, anything else must be equal.
export function matches(value, expected) {
  return expected.some((e) => {
    if (e === null) return blank(value);
    if (Array.isArray(e)) return Array.isArray(value) && value.length === e.length;
    if (typeof e === 'string' && e.startsWith('contains:')) return Array.isArray(value) && value.some((x) => String(x).toLowerCase().includes(e.slice(9)));
    return value === e;
  });
}
