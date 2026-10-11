import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
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
import { investigate } from './agents/investigator.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATUS = { bad_input: 400, not_found: 404, rate_limited: 429, budget: 429, ai_off: 503, bad_json: 502, upstream: 502 };

const coded = (message, code) => Object.assign(new Error(message), { code });
const GLOBAL = '_all_sessions';
const INVESTIGATIONS = '_investigations';

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

// Long model calls report progress to clients that ask for it (Accept:
// application/x-ndjson): one JSON line per step ({"step": ...}, or {"note": ...} to
// update the current one), then {"result": ...} or {"error": ...}. Other clients get
// a single JSON body, as before.
function replier(req, res) {
  const wants = String(req.headers.accept || '').includes('application/x-ndjson');
  let open = false;
  const line = (o) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };
  const send = (o) => {
    if (!wants) return;
    if (!open) {
      open = true;
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    line(o);
  };
  return {
    step: (text) => send({ step: String(text) }),
    note: (text) => send({ note: String(text) }),
    json(body) { if (open) { line({ result: body }); res.end(); } else res.json(body); },
    fail(status, error) { if (open) { line({ error }); res.end(); } else res.status(status).json({ error }); },
  };
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
  // A public URL lets anyone open new sessions, so per-session budgets alone don't
  // bound the bill: there is also one daily cap for the whole deployment.
  const globalTokens = Number(env.AI_GLOBAL_DAILY_TOKENS || 3000000);
  const perSession = rateLimiter({ windowMs: 10 * 60 * 1000, max: Number(env.AI_REQUESTS_PER_10_MIN || 30) });
  // Grounded calls are also billed per search query, so investigations have their own
  // daily counts on top of the token budgets.
  const investigationsPerDay = Number(env.AI_DAILY_INVESTIGATIONS || 40);
  const investigationsPerSession = Number(env.AI_SESSION_INVESTIGATIONS || 8);

  async function allOpps(sid) {
    const [shared, mine] = await Promise.all([store.listShared(), store.listOpps(sid)]);
    const byId = new Map();
    [...mergeSources(dataset, shared), ...mine].forEach((o) => byId.set(o.id, o));
    return [...byId.values()];
  }
  const findOpp = async (sid, id) => (await allOpps(sid)).find((o) => o.id === id) || null;

  // Error mapping for every route; rate limits and token budgets for the ones that can call the model.
  const guarded = (handler, { needsAI = false, usesAI = needsAI } = {}) => async (req, res) => {
    let spent = 0;
    const day = today();
    const reply = replier(req, res);
    try {
      if (needsAI && !llm) throw coded('AI is not configured on this server.', 'ai_off');
      if (usesAI && llm) {
        if (!perSession(req.sid)) throw coded('Too many requests; wait a few minutes.', 'rate_limited');
        if ((await store.usage(req.sid, day)) > dailyTokens) throw coded("Today's AI budget for this session is used up.", 'budget');
        if ((await store.usage(GLOBAL, day)) > globalTokens) throw coded('The demo has used its AI budget for today. The rules engine still works.', 'budget');
      }
      const meter = (n) => { spent += n; };
      const scoped = llm && {
        ...llm,
        generate: (o) => llm.generate({ ...o, meter }),
        ...(llm.ground ? { ground: (o) => llm.ground({ ...o, meter }) } : {}),
      };
      await handler(req, reply, scoped);
    } catch (e) {
      if (!STATUS[e.code]) console.error(e);
      reply.fail(STATUS[e.code] || 500, { code: e.code || 'internal', message: STATUS[e.code] ? e.message : 'Something went wrong on our side.' });
    } finally {
      if (spent > 0) await Promise.all([store.addUsage(req.sid, day, spent), store.addUsage(GLOBAL, day, spent)]).catch(() => {});
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
    // API answers belong to one session; the Firebase Hosting CDN in front must never cache them.
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'private, no-store');
    // Firebase Hosting forwards only a cookie named __session to Cloud Run, so that is the
    // session cookie; nfp_sid is still read for sessions started before Hosting was added.
    const m = /(?:^|;\s*)(?:__session|nfp_sid)=([0-9a-f-]{36})/.exec(req.headers.cookie || '');
    req.sid = m ? m[1] : randomUUID();
    if (!/(?:^|;\s*)__session=/.test(req.headers.cookie || '')) {
      res.append('Set-Cookie', `__session=${req.sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
    }
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

  app.get('/api/dossiers', guarded(async (req, reply) => reply.json({ dossiers: await store.listDossiers(req.sid) })));
  app.put('/api/dossiers', guarded(async (req, reply) => reply.json({ dossier: await store.saveDossier(req.sid, cleanDossier(req.body?.dossier)) })));

  app.post('/api/dossiers/from-github', guarded(async (req, reply, scoped) => {
    reply.json(await buildDossier({ repoUrl: req.body?.url, llm: scoped, fetchImpl, token: env.GITHUB_TOKEN, step: reply.step }));
  }, { usesAI: true }));

  app.post('/api/rank', guarded(async (req, reply) => {
    const dossier = cleanDossier(req.body?.dossier);
    const ranked = rankOpportunities(await allOpps(req.sid), dossier, today(), { allTypes: Boolean(req.body?.allTypes) });
    reply.json({ today: today(), results: ranked });
  }));

  app.post('/api/opportunities/extract', guarded(async (req, reply, scoped) => {
    let text = String(req.body?.text || '');
    let url = String(req.body?.url || '').trim() || null;
    if (!text && url) {
      reply.step('Fetching the rules page.');
      const page = await fetchPage(url, { fetchImpl, ...(resolve ? { resolve } : {}) });
      if (!page.ok) throw coded(page.reason, 'bad_input');
      text = page.text;
      url = page.url || url;
    }
    if (!text.trim()) throw coded('Give a link to the rules or paste their text.', 'bad_input');
    const { opp, stats } = await extractTerms({ text: text.slice(0, 200000), url, llm: scoped, today: today(), step: reply.step });
    await store.saveOpp(req.sid, opp);
    reply.json({ opp, stats });
  }, { needsAI: true }));

  app.post('/api/kit', guarded(async (req, reply, scoped) => {
    const dossier = cleanDossier(req.body?.dossier);
    const opp = await findOpp(req.sid, req.body?.oppId);
    if (!opp) throw coded('Unknown event.', 'not_found');
    reply.json(await draftKit({ opp, dossier, eligibility: checkEligibility(opp, dossier, today()), llm: scoped, step: reply.step, note: reply.note }));
  }, { needsAI: true }));

  app.post('/api/judge', guarded(async (req, reply, scoped) => {
    const opp = await findOpp(req.sid, req.body?.oppId);
    if (!opp) throw coded('Unknown event.', 'not_found');
    const kitText = String(req.body?.kitText || '');
    if (kitText.length < 200) throw coded('Draft the application kit first.', 'bad_input');
    reply.json(await simulateJudges({ opp, kitText, llm: scoped, step: reply.step }));
  }, { needsAI: true }));

  // Due diligence with Gemini, Google Search and URL context. A card is shared by
  // every session for the day (its input is public event data), so each event is
  // searched at most once a day; investigations are counted before the call.
  app.post('/api/investigate', guarded(async (req, reply, scoped) => {
    const opp = await findOpp(req.sid, req.body?.oppId);
    if (!opp) throw coded('Unknown event.', 'not_found');
    const day = today();
    const key = `${day}-${createHash('sha256').update([opp.id, opp.title, opp.url || ''].join('\n')).digest('hex').slice(0, 24)}`;
    const cached = await store.getCard(key);
    if (cached) {
      reply.step('This event was investigated earlier today; showing that card. Nothing new was searched.');
      return reply.json({ card: cached, cached: true });
    }
    const mine = `${req.sid}${INVESTIGATIONS}`;
    if ((await store.usage(mine, day)) >= investigationsPerSession) throw coded('This session has used its investigations for today.', 'budget');
    if ((await store.usage(INVESTIGATIONS, day)) >= investigationsPerDay) throw coded('The demo has used its investigations for today. Cards made earlier today still open.', 'budget');
    await Promise.all([store.addUsage(mine, day, 1), store.addUsage(INVESTIGATIONS, day, 1)]);
    const card = { ...(await investigate({ opp, llm: scoped, fetchImpl, step: reply.step })), day };
    await store.saveCard(key, card);
    reply.json({ card, cached: false });
  }, { needsAI: true }));

  app.get('/api/bets', guarded(async (req, reply) => reply.json({ bets: await store.listBets(req.sid) })));
  app.post('/api/bets', guarded(async (req, reply) => reply.json({ bet: await store.saveBet(req.sid, cleanBet(req.body?.bet)) })));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));
  return app;
}
