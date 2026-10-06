// Matching a team member's employer against the companies behind an event.
// Sponsors routinely bar their own staff (and their affiliates' staff) from winning,
// even when the event's own terms never say so, so we match on corporate families,
// not just exact names.

const SUFFIXES = /\b(inc|llc|ltd|limited|pte|plc|corp|corporation|co|company|gmbh|sa|ag|nv|bv|sas|kk|pty|group|holdings)\b/g;

// Words too common to identify a company on their own ("Open Government Products"
// must not match every "Open Innovation Challenge").
const GENERIC = new Set([
  'the', 'open', 'global', 'international', 'singapore', 'asia', 'pacific', 'digital', 'data', 'ai', 'tech', 'technology',
  'technologies', 'lab', 'labs', 'cloud', 'bank', 'software', 'systems', 'solutions', 'services', 'capital', 'partners',
  'ventures', 'studio', 'studios', 'media', 'health', 'national', 'united', 'first', 'new', 'smart', 'government',
  'products', 'consulting', 'research', 'institute', 'university', 'school', 'centre', 'center', 'foundation', 'hackathon',
]);

export const AFFILIATES = [
  ['google', 'alphabet', 'deepmind', 'youtube', 'kaggle', 'waymo'],
  ['meta', 'facebook', 'instagram', 'whatsapp'],
  ['amazon', 'aws'],
  ['microsoft', 'github', 'linkedin', 'azure'],
  ['bytedance', 'tiktok', 'byteplus'],
  ['tencent', 'wechat'],
  ['alibaba', 'aliyun'],
  ['nvidia'],
  ['openai'],
  ['anthropic'],
  ['paypal', 'venmo', 'braintree'],
  ['apple'],
  ['ibm'],
  ['oracle'],
  ['salesforce', 'slack', 'tableau'],
];

export function normCompany(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{N}\s&-]/gu, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWord(haystack, word) {
  if (!word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(haystack);
}

function familyOf(name) {
  return AFFILIATES.findIndex((group) => group.some((alias) => hasWord(name, alias)));
}

// "DBS Bank" -> "dbs"; "Open Government Products" -> null (first word is generic).
function coreToken(name) {
  const first = name.split(' ')[0];
  return first && first.length >= 3 && !GENERIC.has(first) ? first : null;
}

// True when `employer` and the free text `other` (a sponsor name, an organiser line,
// an event title, a track name) point at the same company or corporate family.
export function sameCompany(employer, other) {
  const e = normCompany(employer);
  const o = normCompany(other);
  if (!e || !o) return false;
  if (hasWord(o, e)) return true;
  if (o.length >= 3 && !GENERIC.has(o) && hasWord(e, o)) return true;
  const fam = familyOf(e);
  if (fam >= 0 && AFFILIATES[fam].some((alias) => hasWord(o, alias))) return true;
  const core = coreToken(e);
  return Boolean(core) && hasWord(o, core);
}
