import { createApp } from './app.js';
import { createStore } from './store/index.js';
import { createLLM } from './agents/llm.js';

const store = await createStore(process.env);
const llm = createLLM(process.env);
const app = await createApp({ store, llm });
const port = Number(process.env.PORT || 8080);

app.listen(port, () => {
  console.log(`No Fine Print on :${port} · store=${store.kind} · ai=${llm ? llm.backend : 'off'}`);
});
