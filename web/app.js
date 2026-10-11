// No Fine Print — browser client. Plain modules, no build step.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const S = { status: null, dossier: null, results: [], filter: 'ok', q: '', open: null, kits: {}, judges: {}, cards: {}, busy: {}, bets: [], view: 'find', addOpen: false };
const STAMP = { ok: 'Eligible', check: 'Check', out: 'Out' };
const RANK = { out: 0, check: 1, warn: 2, ok: 3 };
const ICON = { ok: '✓', warn: '!', check: '?', out: '×' };

const BASES = [['SG', 'Singapore'], ['JAPAC', 'Asia-Pacific'], ['CN', 'Mainland China'], ['OTHER', 'Elsewhere'], ['UNK', 'Location?']];
const PASSES = [['SC', 'Citizen'], ['PR', 'Permanent resident'], ['EP', 'Employment Pass'], ['SP', 'S Pass'], ['DP', "Dependant's Pass"], ['LTVP', 'LTVP'], ['STP', "Student's Pass"], ['OTHER', 'Other pass'], ['UNK', 'Residency?']];
const CHOICES = {
  employed: [['yes', 'Employed'], ['no', 'Not employed'], ['unk', 'Employed?']],
  student: [['no', 'Not a student'], ['yes', 'Student (incl. part-time)'], ['unk', 'Student?']],
  age: [['21', '21+'], ['18', '18–20'], ['u18', 'Under 18'], ['unk', 'Age?']],
};
const WORK_PASSES = ['EP', 'SP', 'DP', 'LTVP', 'STP', 'OTHER'];
const BLANK = () => ({ role: '', base: 'SG', pass: 'UNK', employed: 'unk', student: 'unk', age: 'unk', employer: '', prPending: false });

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: body.__method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
  return data;
}

// Long tasks stream their progress as NDJSON lines ({"step"}, {"note"}, then
// {"result"} or {"error"}; see replier() in src/app.js).
async function apiStream(path, body, { step, note }) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  if (!/x-ndjson/.test(res.headers.get('content-type') || '')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value || new Uint8Array(), { stream: !done }) + (done ? '\n' : '');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines.filter((l) => l.trim())) {
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error.message || 'Something went wrong on our side.');
      if ('result' in msg) return msg.result;
      if (msg.step) step(msg.step);
      if (msg.note) note(msg.note);
    }
    if (done) throw new Error('The connection closed before the answer arrived. Try again.');
  }
}

/* ---------- Progress of long tasks ---------- */

// Running tasks by key: "gh", "add", "inv:<event>", "kit:<event>", "judge:<event>".
// Each paints into its own slot, so a step never re-renders the rest of the page.
const TASKS = {};

function taskHTML(key) {
  const t = TASKS[key];
  if (!t) return '';
  return `<ol class="progress">${t.steps.map((st, i) => {
    const next = t.steps[i + 1];
    const secs = Math.floor(((next ? next.at : Date.now()) - st.at) / 1000);
    return `<li class="${next ? 'done' : 'now'}">${next ? lvl('ok') : '<span class="spin" aria-hidden="true"></span>'}<span>${esc(st.text)}${st.note ? ` <em>${esc(st.note)}</em>` : ''}</span><time${next ? '' : ` data-since="${st.at}"`}>${secs}s</time></li>`;
  }).join('')}</ol>`;
}

const paintTask = (key) => document.querySelectorAll(`[data-task="${key}"]`).forEach((el) => { el.innerHTML = taskHTML(key); });
const slot = (key) => `<div data-task="${esc(key)}" aria-live="polite">${taskHTML(key)}</div>`;

async function runTask(key, path, body) {
  // A placeholder until the server's first step arrives (it replaces this one).
  TASKS[key] = { steps: [{ text: 'Sending the request.', at: Date.now(), placeholder: true }] };
  paintTask(key);
  try {
    return await apiStream(path, body, {
      step: (text) => {
        const t = TASKS[key];
        t.steps = t.steps.filter((st) => !st.placeholder);
        t.steps.push({ text, at: Date.now() });
        paintTask(key);
      },
      note: (text) => { TASKS[key].steps.at(-1).note = text; paintTask(key); },
    });
  } finally {
    delete TASKS[key];
    paintTask(key);
  }
}

setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => {
  el.textContent = `${Math.floor((Date.now() - Number(el.dataset.since)) / 1000)}s`;
}), 1000);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4200);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const lvl = (l) => `<span class="lvl ${l}" aria-label="${l}">${ICON[l]}</span>`;
const byLevel = (a, b) => RANK[a.level] - RANK[b.level];

/* ---------- Dossier ---------- */

function select(i, f, options, v) {
  return `<select data-i="${i}" data-f="${f}" aria-label="${f}">${options.map(([k, label]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function memberHTML(m, i) {
  return `<div class="member">
    <div class="wide"><input type="text" data-i="${i}" data-f="role" value="${esc(m.role)}" placeholder="Role, e.g. Engineer" aria-label="Role"><button class="x" data-act="del-member" data-i="${i}" title="Remove member" aria-label="Remove member">×</button></div>
    ${select(i, 'base', BASES, m.base)}${select(i, 'pass', PASSES, m.pass)}
    ${select(i, 'employed', CHOICES.employed, m.employed)}${select(i, 'student', CHOICES.student, m.student)}
    ${select(i, 'age', CHOICES.age, m.age)}<input type="text" data-i="${i}" data-f="employer" value="${esc(m.employer)}" placeholder="Employer (optional)" aria-label="Employer">
    ${WORK_PASSES.includes(m.pass) ? `<label class="check"><input type="checkbox" data-i="${i}" data-f="prPending"${m.prPending ? ' checked' : ''}> PR application pending</label>` : ''}
  </div>`;
}

function renderDossier() {
  const el = $('#dossier');
  const d = S.dossier;
  if (!d) {
    el.innerHTML = `<h2>Start here</h2><h3>Your project</h3>
      <p class="lede">Paste a public GitHub repository. We read the README, take the date of the <em>first commit</em> (the date "new work only" rules care about), and check your team against every event.</p>
      <form id="gh" class="field"><input type="url" name="url" placeholder="https://github.com/owner/repo" required aria-label="GitHub repository URL">
      <button class="btn"${S.busy.gh ? ' disabled' : ''}>${S.busy.gh ? '<span class="spin"></span>Reading' : 'Build dossier'}</button></form>
      ${slot('gh')}
      <p class="hint">No repository yet? <button class="linkish" data-act="sample">Try a sample team</button></p>`;
    return;
  }
  const facts = (d.evidence || []).map((e) => `<li>${esc(e.fact)}<small>${esc(e.source || '')}${e.quote ? ' · quoted from the README' : ''}</small></li>`).join('');
  const differs = d.repoCreatedAt && d.codeStartedAt && d.repoCreatedAt !== d.codeStartedAt;
  el.innerHTML = `<h2>Dossier</h2><h3>${esc(d.name)}</h3><p class="lede">${esc(d.oneLiner || '')}</p>
    <dl class="datebox"><dt>First commit</dt><dd>${esc(d.codeStartedAt || 'unknown')}</dd>${d.repoCreatedAt ? `<dt>Repo created</dt><dd>${esc(d.repoCreatedAt)}</dd>` : ''}</dl>
    ${differs ? '<p class="hint">"New work only" rules look at the first commit, not the day the repository went public.</p>' : ''}
    <section><h2>Evidence · ${(d.evidence || []).length}</h2><ul class="facts">${facts || '<li>No facts yet.</li>'}</ul></section>
    <section><h2>Team</h2><p class="hint">Every rule is checked per member. Change anything and the ranking updates.</p>
      <div class="team">${(d.team || []).map(memberHTML).join('')}</div>
      <button class="btn ghost small" data-act="add-member" style="margin-top:10px">Add member</button></section>
    <section><button class="linkish" data-act="reset">Start over with another repository</button></section>`;
}

// Saves run one after another, so an older copy of the team can never land after a newer one.
let saving = Promise.resolve();
const saveDossier = debounce(() => {
  saving = saving.then(async () => {
    try {
      const { dossier } = await api('/api/dossiers', { __method: 'PUT', dossier: S.dossier });
      S.dossier.id = dossier.id;
    } catch (e) { toast(e.message); }
  });
}, 600);

// Rankings can come back out of order when the team changes quickly; only the newest counts.
let rankSeq = 0;
async function rank() {
  if (!S.dossier) return renderResults();
  const seq = ++rankSeq;
  try {
    const { results } = await api('/api/rank', { dossier: S.dossier });
    if (seq !== rankSeq) return;
    S.results = results;
    if (S.filter !== 'all' && !results.some((r) => r.elig.status === S.filter)) S.filter = results.some((r) => r.elig.status === 'ok') ? 'ok' : 'all';
  } catch (e) { toast(e.message); }
  renderResults();
  if (S.open) renderDrawer();
}
const rankSoon = debounce(rank, 350);

function changed() { saveDossier(); rankSoon(); }

/* ---------- Results ---------- */

function tab(key, label, n) {
  return `<button type="button" data-filter="${key}" aria-pressed="${S.filter === key}">${label}<b>${n}</b></button>`;
}

function cardHTML(r) {
  const o = r.opp;
  const st = r.elig.status;
  const top = r.elig.reasons.filter((x) => x.level !== 'ok').sort(byLevel).slice(0, 2);
  return `<article class="ticket" tabindex="0" data-open="${esc(o.id)}" aria-label="${esc(o.title)}: ${STAMP[st]}">
    <div class="body"><h4>${esc(o.title)}</h4>
      <div class="org">${esc(o.organizer || '')}${o.sponsors?.length ? ` · backed by ${esc(o.sponsors.join(', '))}` : ''}</div>
      <div class="meta"><span>Deadline <strong>${esc(o.deadline || '—')}</strong></span><span>${esc(r.ev.text)}</span>${o.registrants ? `<span><strong>${Number(o.registrants).toLocaleString('en-US')}</strong> registered</span>` : ''}</div>
      ${top.length ? `<ul class="why">${top.map((x) => `<li>${lvl(x.level)}<span>${esc(x.text)}</span></li>`).join('')}</ul>` : ''}
      ${r.overlap.words.length ? `<div class="chips">${r.overlap.words.map((w) => `<span class="chip">${esc(w)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="stub"><span class="stamp ${st}">${STAMP[st]}</span><span class="days">${r.days ?? '—'}<small>${r.days === 1 ? 'day left' : 'days left'}</small></span></div>
  </article>`;
}

function renderCards() {
  const counts = { ok: 0, check: 0, out: 0 };
  S.results.forEach((r) => { counts[r.elig.status] += 1; });
  const tabs = $('#results .tabs');
  if (tabs) tabs.innerHTML = tab('ok', 'Eligible', counts.ok) + tab('check', 'Check', counts.check) + tab('out', 'Out', counts.out) + tab('all', 'All', S.results.length);
  const q = S.q.trim().toLowerCase();
  const list = S.results.filter((r) => (S.filter === 'all' || r.elig.status === S.filter) && (!q || `${r.opp.title} ${r.opp.organizer || ''}`.toLowerCase().includes(q)));
  const box = $('#results .cards');
  if (box) box.innerHTML = list.slice(0, 80).map(cardHTML).join('') || '<div class="empty">Nothing in this group.</div>';
}

function renderResults() {
  const el = $('#results');
  if (!S.dossier) {
    el.innerHTML = `<div class="empty"><h3>The fine print, read for you.</h3>
      <p>Competition rules hide the clauses that disqualify you: a part-time student on the team, code written before the build window, the sponsor's own staff. Build a dossier and we check every member against every rule, quote the clause, and rank what is left by prize money per entrant.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="toolbar"><div class="tabs" role="group" aria-label="Filter by verdict"></div>
      <input type="search" id="q" placeholder="Search events" value="${esc(S.q)}" aria-label="Search events">
      <button class="btn ghost" data-act="toggle-add">${S.addOpen ? 'Close' : 'Add an event'}</button></div>
    ${S.addOpen ? `<form class="add" id="add"><strong>Add an event from its rules</strong>
      <input type="url" name="url" placeholder="Link to the rules or terms page">
      <textarea name="text" placeholder="…or paste the rules text (works for pages that need a browser)"></textarea>
      <div class="field"><span class="hint" style="margin:0;flex:1">Gemini fills in the eligibility form; every field must quote the rules or it stays unknown.</span>
      <button class="btn"${S.busy.add ? ' disabled' : ''}>${S.busy.add ? '<span class="spin"></span>Reading rules' : 'Read the rules'}</button></div>${slot('add')}</form>` : ''}
    <div class="cards"></div>`;
  renderCards();
}

/* ---------- Drawer ---------- */

function inline(t) {
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[TODO:?([^\]]*)\]/gi, '<span class="todo">[TODO:$1]</span>')
    .replace(/\[E(\d+)\]/g, '<span class="cite">E$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdTable(rows) {
  const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const [head, ...body] = cells;
  return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const LIST = /^\s*([-*]|\d+[.)])\s+/;
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) { const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]); html += mdTable(rows); continue; }
    if (/^#{1,6}\s/.test(l)) { const n = Math.min(4, l.match(/^#+/)[0].length); html += `<h${n}>${inline(l.replace(/^#+\s*/, ''))}</h${n}>`; i++; continue; }
    if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ''));
      html += `<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++]);
    html += `<p>${inline(para.join(' '))}</p>`;
  }
  return html;
}

// Highlight numbers the guard says are not in the dossier, outside of tags only.
function flagNumbers(html, numbers) {
  if (!numbers?.length) return html;
  const re = new RegExp(`(?<![\\w.])(${numbers.map((n) => escRe(esc(n))).join('|')})(?![\\w])`, 'g');
  return html.split(/(<[^>]+>)/).map((seg) => (seg.startsWith('<') ? seg : seg.replace(re, '<mark class="flag" title="Not in your dossier">$1</mark>'))).join('');
}

function kv(label, value) {
  return value ? `<div class="kv"><b>${esc(label)}</b>${value}</div>` : '';
}

function reasonHTML(x) {
  const quote = x.quote ? `<blockquote>“${esc(x.quote)}”${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">Read the clause in context ↗</a>` : ''}</blockquote>` : '';
  return `<li>${lvl(x.level)}<div>${esc(x.text)}${quote}</div></li>`;
}

const EXISTING = { yes: 'Existing projects accepted', no: 'New work only', partial: 'Existing projects if significantly updated', unknown: 'Not stated' };

const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
function shortUrl(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).slice(0, 80); } catch { return String(u || ''); }
}

// The Investigator's card. Only sentences that Google's grounding ties to a cited page
// appear as findings; the rest are listed, collapsed, as unsupported.
function ddHTML({ card: c, cached }) {
  const cite = (ns) => ns.map((n) => {
    const s = c.sources[n - 1];
    return s ? `<a class="src" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" title="${esc(shortUrl(s.url))}">${n}</a>` : '';
  }).join('');
  const read = c.pagesRead || [];
  const made = new Date(c.madeAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const sections = c.sections.map((sec) => `<h5>${esc(sec.title)}</h5>${sec.claims.length
    ? `<ul class="claims">${sec.claims.map((x) => `<li>${esc(x.text)}${cite(x.sources)}</li>`).join('')}</ul>`
    : '<p class="hint">Nothing found that a source backs.</p>'}`).join('');
  // Cards cached before 11 Oct 17:00 SGT carry the old fallback heading, which is wrong when both sides share a page.
  const heading = (k) => (k.samePage && k.topic === 'Two pages disagree' ? 'These statements disagree' : k.topic);
  const conflicts = c.contradictions.length ? c.contradictions.map((k) => `<div class="conflict"><b>${esc(heading(k))}</b>
      ${k.sides.map((sd) => `<p><span class="side">${esc(sd.label)}</span>${esc(sd.text)}${cite(sd.sources)}${sd.eventSite ? '' : ' <span class="tag weak">not from the event\'s own pages</span>'}</p>`).join('')}
      ${k.samePage ? '<p class="hint">Both statements are on the same page.</p>' : ''}</div>`).join('')
    : '<p class="hint">None found with a source on each side.</p>';
  return `<section class="dd" aria-label="Due diligence">
    <h4>Due diligence</h4>
    <p class="hint">Gemini (${esc(c.model || 'Gemini')}) ${read.length ? `read ${read.filter((r) => r.ok).length} of ${read.length} official pages and ` : ''}ran ${c.stats.searches} Google searches${cached ? ', earlier today' : ''} (${esc(made)} SGT). ${c.stats.backed} of ${c.stats.sentences} sentences are tied to a cited page by Google's grounding; only those are shown as findings. The rules engine does not act on this card.</p>
    ${c.suggestions ? `<iframe class="gsearch" title="Google Search suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${esc(`<!doctype html><html><head><base target="_blank"><style>:root{color-scheme:light dark}body{margin:0}</style></head><body>${c.suggestions}</body></html>`)}"></iframe>` : ''}
    ${sections}
    <h5>Contradictions between pages</h5>${conflicts}
    ${c.unsupported.length ? `<details class="unsupported"><summary>${c.unsupported.length} statement${c.unsupported.length === 1 ? '' : 's'} without a source, not shown as findings</summary><ul>
      ${c.unsupported.map((u) => `<li><span class="tag none">unsupported</span> ${esc(u.text)}<small>${esc(u.section)}: ${esc(u.reason)}</small></li>`).join('')}</ul></details>` : ''}
    ${c.sources.length ? `<h5>Sources</h5><ol class="sources">${c.sources.map((s) => `<li value="${s.n}"><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(shortUrl(s.url))}</a>${s.eventSite ? ' <span class="tag own">event site</span>' : ''}</li>`).join('')}</ol>` : ''}
  </section>`;
}

function renderDrawer() {
  const drawer = $('#drawer');
  const r = S.results.find((x) => x.opp.id === S.open);
  if (!r) { drawer.hidden = true; $('#scrim').hidden = true; return; }
  const o = r.opp;
  const kit = S.kits[o.id];
  const judge = S.judges[o.id];
  const dd = S.cards[o.id];
  const ai = S.status?.ai?.on;
  const prize = o.prize?.total_sgd ? `S$${Number(o.prize.total_sgd).toLocaleString('en-US')} pool${o.prize.top_sgd ? ` · top S$${Number(o.prize.top_sgd).toLocaleString('en-US')}` : ''}${o.prize.cash ? ' · cash' : ''}` : '';
  const teamSize = o.elig?.team_min || o.elig?.team_max ? `${o.elig.team_min || 1}–${o.elig.team_max || 'any'} people` : '';
  const judging = (o.judging || []).map((j) => `${esc(j.name)}${j.weight ? ` <b style="display:inline;text-transform:none;letter-spacing:0">${esc(j.weight)}</b>` : ''}`).join('<br>');

  drawer.innerHTML = `<header><span class="stamp ${r.elig.status}">${STAMP[r.elig.status]}</span><h3>${esc(o.title)}</h3><button class="close" data-act="close" aria-label="Close">×</button></header>
    <p class="hint">${esc(o.organizer || '')}${o.url ? ` · <a href="${esc(o.url)}" target="_blank" rel="noopener">official page ↗</a>` : ''}${o.checked ? ` · checked ${esc(o.checked)}` : ''}</p>
    <h4>Eligibility, member by member</h4><ul class="reasons">${[...r.elig.reasons].sort(byLevel).map(reasonHTML).join('')}</ul>
    <h4>Terms</h4><div class="grid2">
      ${kv('Prize', prize)}${kv('Expected value', `${esc(r.ev.text)}<br><span class="hint">${esc(r.ev.basis)}</span>`)}
      ${kv('Existing work', esc(EXISTING[o.accepts_existing] || 'Not stated') + (o.build_start ? `<br><span class="hint">window opens ${esc(o.build_start)}</span>` : ''))}
      ${kv('Team size', esc(teamSize))}${kv('Must use', esc(o.required_tech || ''))}${kv('Judging', judging)}
    </div>
    ${o.unverified?.length ? `<h4>Claims we could not quote</h4><ul class="reasons">${o.unverified.map((u) => `<li>${lvl('check')}<div>${esc(u.field)}: “${esc(u.claimed)}”${u.quote ? `<blockquote>Model's quote, not found in the page: “${esc(u.quote)}”</blockquote>` : ''}</div></li>`).join('')}</ul>` : ''}
    <div class="actions">
      ${dd ? '' : `<button class="btn ghost" data-act="investigate" title="Past editions, judges, sponsors, employee exclusions and contradictions between the event's pages, each with its source"${!ai || S.busy.inv ? ' disabled' : ''}>${S.busy.inv ? '<span class="spin"></span>Investigating' : 'Investigate'}</button>`}
      <button class="btn" data-act="kit"${!ai || S.busy.kit ? ' disabled' : ''}>${S.busy.kit ? '<span class="spin"></span>Drafting' : kit ? 'Redraft application kit' : 'Draft application kit'}</button>
      <button class="btn ghost" data-act="judge"${!ai || !kit || S.busy.judge ? ' disabled' : ''}>${S.busy.judge ? '<span class="spin"></span>Judging' : 'Simulate the judges'}</button>
      ${ai ? '' : '<span class="hint">AI is off on this server; the eligibility engine still works.</span>'}
    </div>
    ${slot(`inv:${o.id}`)}${dd ? ddHTML(dd) : ''}
    ${slot(`kit:${o.id}`)}${slot(`judge:${o.id}`)}
    ${kit ? `<div class="out-box">
      <div class="audit ${kit.audit.ok ? 'ok' : 'bad'}">${kit.audit.ok ? 'Guard passed: every number is in your dossier and every citation exists.' : [
        kit.audit.numbers.length ? `Numbers not in your dossier (highlighted): ${kit.audit.numbers.map(esc).join(', ')}` : '',
        kit.audit.citations.length ? `Citations to evidence that doesn't exist: ${kit.audit.citations.map(esc).join(', ')}` : '',
        kit.audit.phrases.length ? `Wording to fix: ${kit.audit.phrases.map(esc).join('; ')}` : '',
      ].filter(Boolean).join('<br>')}${kit.audit.uncited.length ? `<br>${kit.audit.uncited.length} sentence(s) state a number without citing evidence.` : ''}</div>
      <div class="md">${flagNumbers(md(kit.text), kit.audit.numbers)}</div>
      <p><button class="btn ghost small" data-act="copy-kit">Copy as Markdown</button></p></div>` : ''}
    ${judge ? `<div class="out-box"><h4 style="margin-top:0">Simulated judges · ${esc(judge.overall)}/10</h4><p>${esc(judge.verdict)}</p>
      <table class="scores"><tbody>${(judge.scores || []).map((s) => `<tr><td style="width:38%"><b>${esc(s.criterion)}</b>${s.weight ? ` <span class="hint">${esc(s.weight)}</span>` : ''}<div class="bar"><i style="width:${Math.max(0, Math.min(10, Number(s.score) || 0)) * 10}%"></i></div></td><td>${esc(s.score)}/10 · ${esc(s.why)}${s.missing ? `<br><span class="hint">Would score higher with: ${esc(s.missing)}</span>` : ''}</td></tr>`).join('')}</tbody></table>
      <h4>Biggest fixes</h4><ol>${(judge.fixes || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ol></div>` : ''}
    <h4>Log a prediction before you commit</h4>
    <form class="bet" id="bet"><label>Chance of any prize (%)<input type="number" name="p" min="0" max="100" step="1" required></label>
      <label>Hours you'll spend<input type="number" name="h" min="0" step="1"></label>
      <label>Why<input type="text" name="why" placeholder="What makes you think so"></label><button class="btn">Log it</button></form>
    <p class="hint">Write the prediction down before the result. The ledger scores your calibration (Brier score) once results are in.</p>`;
  drawer.hidden = false;
  $('#scrim').hidden = false;
}

/* ---------- Ledger ---------- */

async function renderLedger() {
  const el = $('#view-ledger');
  try { S.bets = (await api('/api/bets')).bets; } catch (e) { toast(e.message); }
  const resolved = S.bets.filter((b) => b.outcome && b.outcome !== 'withdrawn');
  const brier = resolved.length ? resolved.reduce((s, b) => s + (b.pWin - (b.outcome === 'win' ? 1 : 0)) ** 2, 0) / resolved.length : null;
  el.innerHTML = `<div class="toolbar"><div><h2 style="font-size:22px">Prediction ledger</h2><p class="hint">Predict before you build; score yourself after. Lower Brier is better (0 is perfect, 0.25 is a coin flip).</p></div>
      <div style="margin-left:auto;text-align:right"><div class="score">${brier == null ? '—' : brier.toFixed(3)}</div><span class="hint">Brier · ${resolved.length} resolved</span></div></div>
    ${S.bets.length ? `<table><thead><tr><th>Event</th><th>Project</th><th>P(prize)</th><th>Hours</th><th>Why</th><th>Outcome</th></tr></thead><tbody>
      ${S.bets.map((b) => `<tr><td>${esc(b.oppTitle)}</td><td>${esc(b.dossierName)}</td><td>${Math.round(b.pWin * 100)}%</td><td>${esc(b.hours)}</td><td>${esc(b.why)}</td>
        <td><select data-bet="${esc(b.id)}" aria-label="Outcome">${[['', 'pending'], ['win', 'won a prize'], ['finalist', 'finalist, no prize'], ['lost', 'not shortlisted'], ['withdrawn', 'did not submit']].map(([k, l]) => `<option value="${k}"${b.outcome === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No predictions yet. Open an event and log one before you commit to it.</div>'}`;
}

/* ---------- Events ---------- */

function setView(v) {
  S.view = v;
  document.querySelectorAll('[data-view]').forEach((b) => (b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('#view-find').hidden = v !== 'find';
  $('#view-ledger').hidden = v !== 'ledger';
  if (v === 'ledger') renderLedger();
}

function openDrawer(id) { S.open = id; renderDrawer(); }
function closeDrawer() { S.open = null; renderDrawer(); }

async function useDossier(d) {
  S.dossier = { team: [], evidence: [], ...d };
  if (!S.dossier.team.length) S.dossier.team = [BLANK()];
  renderDossier();
  saveDossier();
  await rank();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act],[data-open],[data-view],[data-filter]');
  if (!t) { if (ev.target.id === 'scrim') closeDrawer(); return; }
  if (t.dataset.view) return setView(t.dataset.view);
  if (t.dataset.filter) { S.filter = t.dataset.filter; return renderCards(); }
  if (t.dataset.open) return openDrawer(t.dataset.open);
  const act = t.dataset.act;
  if (act === 'close') closeDrawer();
  else if (act === 'sample') { const { dossier } = await api('/api/sample'); await useDossier(dossier); toast('Sample loaded. Try marking the data scientist as "Not a student".'); }
  else if (act === 'reset') { S.dossier = null; S.results = []; renderDossier(); renderResults(); }
  else if (act === 'add-member') { S.dossier.team.push(BLANK()); renderDossier(); changed(); }
  else if (act === 'del-member') { S.dossier.team.splice(Number(t.dataset.i), 1); renderDossier(); changed(); }
  else if (act === 'toggle-add') { S.addOpen = !S.addOpen; renderResults(); }
  else if (act === 'investigate') runInvestigate();
  else if (act === 'kit') runKit();
  else if (act === 'judge') runJudge();
  else if (act === 'copy-kit') { await navigator.clipboard.writeText(S.kits[S.open]?.text || ''); toast('Copied.'); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S.open) closeDrawer();
  if (ev.key === 'Enter' && ev.target.classList?.contains('ticket')) openDrawer(ev.target.dataset.open);
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'q') { S.q = t.value; renderCards(); return; }
  if (t.dataset.f && t.type === 'text') { S.dossier.team[Number(t.dataset.i)][t.dataset.f] = t.value; changed(); }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.bet) {
    const bet = S.bets.find((b) => b.id === t.dataset.bet);
    if (bet) { bet.outcome = t.value; await api('/api/bets', { bet }).catch((e) => toast(e.message)); renderLedger(); }
    return;
  }
  if (!t.dataset.f || t.type === 'text') return;
  S.dossier.team[Number(t.dataset.i)][t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.f === 'pass') renderDossier();
  changed();
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.id === 'gh') {
    S.busy.gh = true; renderDossier();
    try {
      const r = await runTask('gh', '/api/dossiers/from-github', { url: f.url.value });
      await useDossier(r.dossier);
      toast(r.ai ? `Dossier built. ${r.dropped ? `${r.dropped} README claim(s) dropped because the quote didn't match.` : ''}` : 'Dossier built from GitHub data (AI is off, so the README was not summarised).');
    } catch (e) { toast(e.message); }
    S.busy.gh = false; renderDossier();
  } else if (f.id === 'add') {
    S.busy.add = true; renderResults();
    try {
      const { opp, stats } = await runTask('add', '/api/opportunities/extract', { url: f.url.value, text: f.text.value });
      S.addOpen = false;
      await rank();
      openDrawer(opp.id);
      toast(`Read the rules: ${stats.verified} of ${stats.claimed} claims backed by an exact quote.`);
    } catch (e) { toast(e.message); }
    S.busy.add = false; renderResults();
  } else if (f.id === 'bet') {
    const r = S.results.find((x) => x.opp.id === S.open);
    try {
      await api('/api/bets', { bet: { oppId: r.opp.id, oppTitle: r.opp.title, dossierName: S.dossier.name, pWin: Number(f.p.value) / 100, hours: Number(f.h.value) || 0, why: f.why.value } });
      toast('Logged. Score it in the Ledger when the result is out.');
      f.reset();
    } catch (e) { toast(e.message); }
  }
});

async function runInvestigate() {
  const id = S.open;
  S.busy.inv = true; renderDrawer();
  try { S.cards[id] = await runTask(`inv:${id}`, '/api/investigate', { oppId: id }); } catch (e) { toast(e.message); }
  S.busy.inv = false; if (S.open === id) renderDrawer();
}

async function runKit() {
  const id = S.open;
  S.busy.kit = true; renderDrawer();
  try { S.kits[id] = await runTask(`kit:${id}`, '/api/kit', { dossier: S.dossier, oppId: id }); delete S.judges[id]; } catch (e) { toast(e.message); }
  S.busy.kit = false; if (S.open === id) renderDrawer();
}

async function runJudge() {
  const id = S.open;
  S.busy.judge = true; renderDrawer();
  try { S.judges[id] = await runTask(`judge:${id}`, '/api/judge', { oppId: id, kitText: S.kits[id].text }); } catch (e) { toast(e.message); }
  S.busy.judge = false; if (S.open === id) renderDrawer();
}

async function boot() {
  try {
    S.status = await api('/api/status');
    const pill = $('#ai-pill');
    pill.textContent = S.status.ai.on ? `Gemini · ${S.status.ai.model}` : 'AI off · rules engine only';
    pill.classList.toggle('on', S.status.ai.on);
  } catch { $('#ai-pill').textContent = 'offline'; }
  try {
    const { dossiers } = await api('/api/dossiers');
    if (dossiers?.length) { await useDossier(dossiers.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]); return; }
  } catch { /* fresh session */ }
  renderDossier();
  renderResults();
}

boot();
