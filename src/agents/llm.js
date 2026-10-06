// Thin wrapper over the Google Gen AI SDK. On Cloud Run it talks to Gemini through
// Vertex AI with the service account (no API keys in the container); locally it can
// use a Gemini API key. Without either, AI features are switched off and the
// deterministic parts of the app still work.

import { GoogleGenAI } from '@google/genai';

const FALLBACK_MODEL = 'gemini-2.5-flash';

// Prefer the newest stable Flash model; fall back to previews only if nothing stable is listed.
export function pickModel(names) {
  const flash = names.filter((n) => /^gemini-\d+(\.\d+)?-flash(-\d{3})?(-preview(-[\w-]+)?)?$/.test(n));
  const score = (n) => parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)/)[1]) * 10 - (/preview/.test(n) ? 100 : 0) - (/-\d{3}$/.test(n) ? 0.1 : 0);
  return flash.sort((a, b) => score(b) - score(a))[0] || null;
}

export function createLLM(env = process.env, { client } = {}) {
  const vertex = String(env.GOOGLE_GENAI_USE_VERTEXAI || '').toLowerCase() === 'true';
  if (!client && !vertex && !env.GEMINI_API_KEY) return null;
  const ai = client || (vertex
    ? new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GOOGLE_CLOUD_LOCATION || 'global' })
    : new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));

  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let model = env.GEMINI_MODEL || null;
  let resolving = null;

  async function resolveModel() {
    if (model) return model;
    resolving ||= (async () => {
      try {
        const names = [];
        for await (const m of await ai.models.list({ config: { queryBase: true, pageSize: 100 } })) names.push(String(m.name || '').split('/').pop());
        model = pickModel(names) || FALLBACK_MODEL;
      } catch {
        model = FALLBACK_MODEL;
      }
      return model;
    })();
    return resolving;
  }

  async function generate({ system, prompt, schema, temperature = 0.2, maxOutputTokens = 8192, meter }) {
    const res = await ai.models.generateContent({
      model: await resolveModel(),
      contents: prompt,
      config: {
        systemInstruction: system,
        temperature,
        maxOutputTokens,
        ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
      },
    });
    const u = res.usageMetadata || {};
    const inTok = u.promptTokenCount || 0;
    const outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
    usage.calls += 1;
    usage.inputTokens += inTok;
    usage.outputTokens += outTok;
    meter?.(inTok + outTok);
    const text = res.text ?? '';
    if (!schema) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('The model returned malformed JSON; try again.'), { code: 'bad_json' });
    }
  }

  return { generate, resolveModel, usage, backend: vertex ? 'vertex-ai' : 'gemini-api', get model() { return model; } };
}
