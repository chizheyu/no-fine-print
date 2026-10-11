import test from 'node:test';
import assert from 'node:assert/strict';
import { completeKit, draftKit } from '../src/agents/coach.js';
import { createLLM } from '../src/agents/llm.js';

const SECTIONS = ['## One-line pitch', '## Title options (3)', '## How we map to the judging criteria', '## Submission text',
  '## 3-minute demo script', '## Deliverables checklist', '## Risks and compliance'];
const fullKit = SECTIONS.map((h) => `${h}\nSomething specific [E1].`).join('\n\n');

const opp = { id: 'x', title: 'Example Cup', judging: [] };
const dossier = { name: 'Widget', evidence: [{ id: 'E1', fact: '373 engine tests' }] };

test('a kit with notes on top is trimmed to its first section', () => {
  const k = completeKit(`Let me think about the pitch first.\n\n${fullKit}`);
  assert.equal(k.ok, true);
  assert.ok(k.text.startsWith('## One-line pitch'));
});

test('a cut-off kit is incomplete (the live failure ended at "## One-")', () => {
  const k = completeKit('Drafting notes: the judges want specifics.\n## One-');
  assert.equal(k.ok, false);
  assert.ok(k.missing.includes('Risks and compliance'));
  assert.equal(completeKit(fullKit.replace(/## Risks and compliance[\s\S]*$/, '## Risks and compliance\n')).ok, false);
});

test('draftKit drafts once more when the first draft is incomplete, and gives up after two', async () => {
  const replies = ['Notes only.\n## One-', `Here you go.\n${fullKit}`];
  let calls = 0;
  const steps = [];
  const llm = { async generate() { return replies[calls++]; } };
  const r = await draftKit({ opp, dossier, llm, step: (s) => steps.push(s) });
  assert.equal(calls, 2);
  assert.ok(r.text.startsWith('## One-line pitch'));
  assert.ok(steps.some((s) => /incomplete/.test(s)));

  const truncated = { async generate() { throw Object.assign(new Error('ran out of room'), { code: 'truncated' }); } };
  await assert.rejects(draftKit({ opp, dossier, llm: truncated }), (e) => e.code === 'incomplete_kit');
});

test('generate asks Gemini 3 for low thinking and reports a draft cut off by the token limit', async () => {
  let seen;
  const client = {
    models: {
      async generateContent(req) {
        seen = req;
        return { text: '## One-', candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '## One-' }] } }], usageMetadata: {} };
      },
    },
  };
  const llm = createLLM({ GEMINI_MODEL: 'gemini-3.8-flash' }, { client });
  await assert.rejects(llm.generate({ system: 's', prompt: 'p' }), (e) => e.code === 'truncated');
  assert.deepEqual(seen.config.thinkingConfig, { thinkingLevel: 'low' });

  const old = createLLM({ GEMINI_MODEL: 'gemini-2.5-flash' }, { client });
  await assert.rejects(old.generate({ system: 's', prompt: 'p' }), (e) => e.code === 'truncated');
  assert.equal(seen.config.thinkingConfig, undefined);
});
