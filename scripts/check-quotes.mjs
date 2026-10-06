// Usage: node scripts/check-quotes.mjs <source.txt> "<quote>" ["<quote>" ...]
import { readFileSync } from 'node:fs';
import { verifyQuote } from '../src/quotes.js';
const [file, ...quotes] = process.argv.slice(2);
const src = readFileSync(file, 'utf8');
let bad = 0;
for (const q of quotes) { const r = verifyQuote(q, src); if (!r.ok) bad++; console.log(r.ok ? 'OK  ' : 'FAIL', q.slice(0, 90)); }
process.exit(bad ? 1 : 0);
