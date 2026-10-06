import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { rankOpportunities } from './engine/ranking.js';
import { checkEligibility } from './engine/eligibility.js';
import { todayIn } from './engine/dates.js';
import { cleanDossier, cleanBet } from './sanitize.js';
import { fetchPage } from './sources/fetchPage.js';
import { extractTerms } from './agents/clerk.js';
import { buildDossier } from './agents/profiler.js';
import { draftKit, simulateJudges } from './agents/coach.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATUS = { bad_input: 400, not_found: 404, rate_limited: 429, budget: 429, ai_off: 503, bad_json: 502, upstream: 502 };

const coded = (message, code) => Object.assign(new Error(message), { code });

const urlKey = (u) => String(u || '').toLowerCase().replace(/\/rules\/?$/, '').replace(/\/+$/, '');

// Hand-checked seeds keep their terms and only take fresh registrant counts from a
// scan; seeds that came from an earlier scan are replaced by the newer one.
export function mergeSources(seeds, scanned) {
  const fresh = new Map(scanned.filter((o) => o.url).map((o) => [urlKey(o.url), o]));
  const merged = seeds.map((s) => {
    const f = fresh.get(urlKey(s.url));
    if (!f) return s;
    fresh.delete(urlKey(s.url));
    return s.provenance === 'official'
      ? { ...s, registrants: f.registrants ?? s.registrants, registrants_checked: f.registrants_checked ?? s.registrants_checked }
      : { ...f, id: s.id };
  });
  return [...merged, ...fresh.values()];
}

function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 20000) hits.delete(hits.keys().next().value);
    return true;
  };
}

export async function createApp({ store, llm = null, env = process.env, fetchImpl = fetch, resolve, today = () => todayIn() }) {
  const seeds = JSON.parse(await readFile(path.join(ROOT, 'data', 'opportunities.json'), 'utf8')).opportunities;
  // A local scan (npm run scan) lands in data/scanned.json; on Cloud Run scans go to Firestore.
  const scannedFile = await readFile(path.join(ROOT, 'data', 'scanned.json'), 'utf8').then((t) => JSON.parse(t).opportunities, () => []);
  const dataset = mergeSources(seeds, scannedFile);
  const sample = JSON.parse(await readFile(path.join(ROOT, 'data', 'sample-dossier.json'), 'utf8'));
  const dailyTokens = Number(env.AI_DAILY_TOKENS || 400000);
  const perSession = rateLimiter({ windowMs: 10 * 60 * 1000, max: Number(env.AI_REQUESTS_PER_10_MIN || 30) });

  async function allOpps(sid) {
    const [shared, mine] = await Promise.all([store.listShared(), store.listOpps(sid)]);
    const byId = new Map();
    [...mergeSources(dataset, shared), ...mine].forEach((o) => byId.set(o.id, o));
    return [...byId.values()];
  }
  const findOpp = async (sid, id) => (await allOpps(sid)).find((o) => o.id === id) || null;

  // Rate limits, a daily token budget per session, and error mapping for every model-backed route.
  const guarded = (handler, { needsAI = false } = {}) => async (req, res) => {
    let spent = 0;
    const day = today();
    try {
      if (needsAI && !llm) throw coded('AI is not configured on this server.', 'ai_off');
      if (!perSession(req.sid)) throw coded('Too many requests; wait a few minutes.', 'rate_limited');
      if (llm && (await store.usage(req.sid, day)) > dailyTokens) throw coded("Today's AI budget for this session is used up.", 'budget');
      const scoped = llm && { ...llm, generate: (o) => llm.generate({ ...o, meter: (n) => { spent += n; } }) };
      await handler(req, res, scoped);
    } catch (e) {
      if (!STATUS[e.code]) console.error(e);
      res.status(STATUS[e.code] || 500).json({ error: { code: e.code || 'internal', message: STATUS[e.code] ? e.message : 'Something went wrong on our side.' } });
    } finally {
      if (spent > 0) await store.addUsage(req.sid, day, spent).catch(() => {});
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    const m = /(?:^|;\s*)nfp_sid=([0-9a-f-]{36})/.exec(req.headers.cookie || '');
    req.sid = m ? m[1] : randomUUID();
    if (!m) res.append('Set-Cookie', `nfp_sid=${req.sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
    next();
  });
  app.use(express.static(path.join(ROOT, 'web'), { extensions: ['html'], maxAge: '5m' }));

  app.get('/api/status', (req, res) => res.json({
    today: today(),
    ai: llm ? { on: true, backend: llm.backend, model: llm.model || 'auto' } : { on: false },
    store: store.kind,
    opportunities: dataset.length,
  }));

  app.get('/api/sample', (req, res) => res.json({ dossier: sample }));

  app.get('/api/dossiers', guarded(async (req, res) => res.json({ dossiers: await store.listDossiers(req.sid) })));
  app.put('/api/dossiers', guarded(async (req, res) => res.json({ dossier: await store.saveDossier(req.sid, cleanDossier(req.body?.dossier)) })));

  app.post('/api/dossiers/from-github', guarded(async (req, res, scoped) => {
    res.json(await buildDossier({ repoUrl: req.body?.url, llm: scoped, fetchImpl, token: env.GITHUB_TOKEN }));
  }));

  app.post('/api/rank', guarded(async (req, res) => {
    const dossier = cleanDossier(req.body?.dossier);
    const ranked = rankOpportunities(await allOpps(req.sid), dossier, today(), { allTypes: Boolean(req.body?.allTypes) });
    res.json({ today: today(), results: ranked });
  }));

  app.post('/api/opportunities/extract', guarded(async (req, res, scoped) => {
    let text = String(req.body?.text || '');
    let url = String(req.body?.url || '').trim() || null;
    if (!text && url) {
      const page = await fetchPage(url, { fetchImpl, ...(resolve ? { resolve } : {}) });
      if (!page.ok) throw coded(page.reason, 'bad_input');
      text = page.text;
      url = page.url || url;
    }
    if (!text.trim()) throw coded('Give a link to the rules or paste their text.', 'bad_input');
    const { opp, stats } = await extractTerms({ text: text.slice(0, 200000), url, llm: scoped, today: today() });
    await store.saveOpp(req.sid, opp);
    res.json({ opp, stats });
  }, { needsAI: true }));

  app.post('/api/kit', guarded(async (req, res, scoped) => {
    const dossier = cleanDossier(req.body?.dossier);
    const opp = await findOpp(req.sid, req.body?.oppId);
    if (!opp) throw coded('Unknown event.', 'not_found');
    res.json(await draftKit({ opp, dossier, eligibility: checkEligibility(opp, dossier, today()), llm: scoped }));
  }, { needsAI: true }));

  app.post('/api/judge', guarded(async (req, res, scoped) => {
    const opp = await findOpp(req.sid, req.body?.oppId);
    if (!opp) throw coded('Unknown event.', 'not_found');
    const kitText = String(req.body?.kitText || '');
    if (kitText.length < 200) throw coded('Draft the application kit first.', 'bad_input');
    res.json(await simulateJudges({ opp, kitText, llm: scoped }));
  }, { needsAI: true }));

  app.get('/api/bets', guarded(async (req, res) => res.json({ bets: await store.listBets(req.sid) })));
  app.post('/api/bets', guarded(async (req, res) => res.json({ bet: await store.saveBet(req.sid, cleanBet(req.body?.bet)) })));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));
  return app;
}
