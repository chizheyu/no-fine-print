// Nightly scan (Cloud Run Job, triggered by Cloud Scheduler). Writes open Devpost
// hackathons to the shared `opportunities` collection; locally it writes
// data/scanned.json, which the server also loads.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanDevpost } from '../src/sources/devpost.js';
import { createStore } from '../src/store/index.js';
import { todayIn } from '../src/engine/dates.js';

const today = todayIn();
const opps = await scanDevpost({ today, readRulePages: !process.argv.includes('--no-rules'), log: console.warn });
const withExisting = opps.filter((o) => o.accepts_existing !== 'unknown').length;

if (process.env.STORE === 'firestore') {
  const store = await createStore(process.env);
  await store.upsertShared(opps);
  console.log(`scan ${today}: ${opps.length} open Devpost hackathons → Firestore (existing-work clause found in ${withExisting})`);
} else {
  const file = fileURLToPath(new URL('../data/scanned.json', import.meta.url));
  await writeFile(file, JSON.stringify({ generated: today, count: opps.length, opportunities: opps }, null, 1));
  console.log(`scan ${today}: ${opps.length} open Devpost hackathons → ${file} (existing-work clause found in ${withExisting})`);
}
