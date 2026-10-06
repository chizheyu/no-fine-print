// Facts about a public GitHub repository that a judge could check for themselves.
//
// The date that decides "is this new work?" is the first commit, not the date the
// repository was created on GitHub: a project written privately in August and
// published in September started in August.

const UA = 'NoFinePrint/0.1 (+https://github.com/chizheyu/no-fine-print)';

export function parseRepo(raw) {
  const m = String(raw || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function repoFacts({ owner, repo }, { fetchImpl = fetch, token } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const get = async (url, accept) => {
    const res = await fetchImpl(url, { headers: accept ? { ...headers, Accept: accept } : headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) throw Object.assign(new Error('Repository not found (it must be public).'), { code: 'not_found' });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error('GitHub rate limit reached. Try again in a few minutes.'), { code: 'rate_limited' });
    if (!res.ok) throw Object.assign(new Error(`GitHub answered HTTP ${res.status}.`), { code: 'upstream' });
    return res;
  };
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const meta = await (await get(base)).json();

  // Commits come newest first; the last page holds the root commit.
  const first = await get(`${base}/commits?per_page=1`);
  let oldest = (await first.json())[0];
  const last = (first.headers.get('link') || '').match(/<([^>]+)>;\s*rel="last"/);
  if (last) oldest = (await (await get(last[1])).json())[0];
  const dates = [oldest?.commit?.author?.date, oldest?.commit?.committer?.date].filter(Boolean).sort();

  let readme = '';
  try { readme = await (await get(`${base}/readme`, 'application/vnd.github.raw')).text(); } catch (e) { if (e.code !== 'not_found') throw e; }

  return {
    owner, repo,
    name: meta.name,
    description: meta.description || '',
    url: meta.html_url,
    homepage: meta.homepage || '',
    createdAt: (meta.created_at || '').slice(0, 10),
    pushedAt: (meta.pushed_at || '').slice(0, 10),
    license: meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : null,
    stars: meta.stargazers_count ?? 0,
    topics: meta.topics || [],
    language: meta.language || null,
    firstCommitAt: dates[0] ? dates[0].slice(0, 10) : null,
    firstCommitSha: oldest?.sha || null,
    readme,
  };
}
