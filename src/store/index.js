// Storage. Each browser session gets its own space (dossiers, added events, bets).
// Locally everything lives in memory; on Cloud Run set STORE=firestore.

import { randomUUID } from 'node:crypto';

const MAX_SESSIONS = 5000;

export function memoryStore() {
  const sessions = new Map();
  const shared = new Map();
  const space = (sid) => {
    if (!sessions.has(sid)) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(sid, { dossiers: new Map(), opps: new Map(), bets: new Map(), usage: new Map() });
    }
    return sessions.get(sid);
  };
  return {
    kind: 'memory',
    async listDossiers(sid) { return [...space(sid).dossiers.values()]; },
    async getDossier(sid, id) { return space(sid).dossiers.get(id) || null; },
    async saveDossier(sid, d) { const doc = { ...d, id: d.id || randomUUID(), updatedAt: new Date().toISOString() }; space(sid).dossiers.set(doc.id, doc); return doc; },
    async listOpps(sid) { return [...space(sid).opps.values()]; },
    async saveOpp(sid, o) { space(sid).opps.set(o.id, o); return o; },
    async listShared() { return [...shared.values()]; },
    async upsertShared(opps) { opps.forEach((o) => shared.set(o.id, o)); return opps.length; },
    async listBets(sid) { return [...space(sid).bets.values()]; },
    async saveBet(sid, b) { const doc = { ...b, id: b.id || randomUUID() }; space(sid).bets.set(doc.id, doc); return doc; },
    async usage(sid, day) { return space(sid).usage.get(day) || 0; },
    async addUsage(sid, day, tokens) { const u = space(sid).usage; u.set(day, (u.get(day) || 0) + tokens); },
  };
}

export async function firestoreStore(env) {
  const { Firestore, FieldValue } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: env.GOOGLE_CLOUD_PROJECT, ignoreUndefinedProperties: true });
  const col = (sid, name) => db.collection('sessions').doc(sid).collection(name);
  const all = async (q) => (await q.get()).docs.map((d) => d.data());
  return {
    kind: 'firestore',
    async listDossiers(sid) { return all(col(sid, 'dossiers').orderBy('updatedAt', 'desc').limit(20)); },
    async getDossier(sid, id) { const s = await col(sid, 'dossiers').doc(id).get(); return s.exists ? s.data() : null; },
    async saveDossier(sid, d) { const doc = { ...d, id: d.id || randomUUID(), updatedAt: new Date().toISOString() }; await col(sid, 'dossiers').doc(doc.id).set(doc); return doc; },
    async listOpps(sid) { return all(col(sid, 'opps').limit(100)); },
    async saveOpp(sid, o) { await col(sid, 'opps').doc(o.id).set(o); return o; },
    async listShared() { return all(db.collection('opportunities').limit(1000)); },
    async upsertShared(opps) {
      for (let i = 0; i < opps.length; i += 400) {
        const batch = db.batch();
        opps.slice(i, i + 400).forEach((o) => batch.set(db.collection('opportunities').doc(o.id), o, { merge: true }));
        await batch.commit();
      }
      return opps.length;
    },
    async listBets(sid) { return all(col(sid, 'bets').limit(200)); },
    async saveBet(sid, b) { const doc = { ...b, id: b.id || randomUUID() }; await col(sid, 'bets').doc(doc.id).set(doc); return doc; },
    async usage(sid, day) { const s = await col(sid, 'usage').doc(day).get(); return s.exists ? s.data().tokens || 0 : 0; },
    async addUsage(sid, day, tokens) { await col(sid, 'usage').doc(day).set({ tokens: FieldValue.increment(tokens) }, { merge: true }); },
  };
}

export async function createStore(env = process.env) {
  return env.STORE === 'firestore' ? firestoreStore(env) : memoryStore();
}
