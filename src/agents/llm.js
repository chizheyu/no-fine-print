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

  // Search results fed back to the model (toolUsePromptTokenCount) are billed as input.
  function record(u = {}, meter) {
    const inTok = (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0);
    const outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
    usage.calls += 1;
    usage.inputTokens += inTok;
    usage.outputTokens += outTok;
    meter?.(inTok + outTok);
  }

  // Streams when the caller wants to watch the text grow (onText gets everything so far).
  async function run(request, onText) {
    if (!onText) {
      const res = await ai.models.generateContent(request);
      const c = res.candidates?.[0];
      return { text: res.text ?? '', usage: res.usageMetadata, metadata: c?.groundingMetadata, pages: c?.urlContextMetadata?.urlMetadata, finishReason: c?.finishReason };
    }
    let text = '';
    let last = {};
    let metadata;
    let pages;
    let finishReason;
    for await (const chunk of await ai.models.generateContentStream(request)) {
      const c = chunk.candidates?.[0];
      if (c?.finishReason) finishReason = c.finishReason;
      const part = (c?.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
      if (part) { text += part; onText(text); }
      if (chunk.usageMetadata) last = chunk.usageMetadata;
      // Grounding metadata comes with the last chunk; keep the latest one that has supports.
      if (c?.groundingMetadata && (c.groundingMetadata.groundingSupports?.length || !metadata)) metadata = c.groundingMetadata;
      if (c?.urlContextMetadata?.urlMetadata?.length) pages = c.urlContextMetadata.urlMetadata;
    }
    return { text, usage: last, metadata, pages, finishReason };
  }

  async function generate({ system, prompt, schema, temperature = 0.2, maxOutputTokens = 8192, meter, onText }) {
    const name = await resolveModel();
    const { text, usage: u, finishReason } = await run({
      model: name,
      contents: prompt,
      config: {
        systemInstruction: system,
        temperature,
        maxOutputTokens,
        ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
        // Gemini 3 counts its thinking against maxOutputTokens; at the default level a long
        // draft could run out of room before the answer ended (seen live on 11 Oct).
        ...(/^gemini-([3-9]|\d\d)/.test(name) ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
      },
    }, onText);
    record(u, meter);
    if (finishReason === 'MAX_TOKENS') {
      throw Object.assign(new Error('The model ran out of room before finishing; try again.'), { code: 'truncated' });
    }
    if (!schema) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('The model returned malformed JSON; try again.'), { code: 'bad_json' });
    }
  }

  // Gemini grounded in Google Search, plus URL context when the caller names pages to
  // read directly. Returns the text and the grounding metadata as the API sends it:
  // groundingChunks (web pages), groundingSupports (which span of the text each page
  // supports), webSearchQueries and the searchEntryPoint widget; `pages` says which
  // named pages were actually retrieved.
  async function ground({ system, prompt, urls = [], temperature = 0, maxOutputTokens = 8192, meter, onText, timeoutMs = 150000 }) {
    const name = await resolveModel();
    const { text, usage: u, metadata, pages } = await run({
      model: name,
      contents: prompt,
      config: {
        systemInstruction: system,
        temperature,
        maxOutputTokens,
        tools: [{ googleSearch: {} }, ...(urls.length ? [{ urlContext: {} }] : [])],
        // Gemini 3 bills grounding per search query; low thinking runs fewer of them.
        ...(/^gemini-([3-9]|\d\d)/.test(name) ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
    }, onText || (() => {}));
    record(u, meter);
    return { text, metadata: metadata || {}, pages: pages || [], model: name };
  }

  return { generate, ground, resolveModel, usage, backend: vertex ? 'vertex-ai' : 'gemini-api', get model() { return model; } };
}
