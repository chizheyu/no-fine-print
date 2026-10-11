# No Fine Print

**Which competitions can your team actually win?** No Fine Print reads the rules of hackathons, grants and innovation challenges, checks every member of your team against them, quotes the clause behind every verdict, and ranks what is left by prize money per entrant. For any event it can run due diligence on the web (past editions, judges, sponsors, whose staff are barred, and where the event's own pages contradict each other), showing only what a cited page backs. Then it drafts an application that cannot overclaim.

Built for the Google Cloud AI Builder Cup 2026 (theme: Future of Work & Enterprise Productivity).

**Live:** https://no-fine-print-2026.web.app (Firebase Hosting in front; the same app answers directly at https://no-fine-print-233540464251.asia-southeast1.run.app on Cloud Run, asia-southeast1; Gemini through Vertex AI; Firestore)

**Deck:** [docs/No_Fine_Print_deck.pdf](docs/No_Fine_Print_deck.pdf) (13 slides: problem, how it decides, architecture on Google Cloud, evaluation, business case). The slide source and the architecture diagram are in [docs/deck/](docs/deck/).

## The problem

Small teams pick competitions with almost no decision support. Eligibility rules are scattered across microsites, FAQs and terms documents that change without notice, and the clauses that disqualify you are the ones nobody reads:

- a teammate doing a part-time master's degree gets the whole team disqualified ("Full-time or part-time students are strictly ineligible");
- a prototype written in August, published on GitHub in September, is still "pre-existing" for an event whose build window opened in between;
- a teammate who works for the sponsor can't compete for prizes, even when the event's own terms never say so.

In our seed dataset, 98 of 113 open competitions had at least one condition (residency, student status, or whether existing work counts) that our first research pass could not pin down from the official pages. And prize pools mislead: across the 25 events where both the pool and the registrant count are public, the expected prize per registrant ranges from S$0.55 to S$2,322.

## How it decides

Gemini reads; code decides. Four rules hold everywhere:

1. **Every claim about the rules must quote the rules.** When Gemini extracts an eligibility field, it must copy the sentence that states it. We then look for that sentence in the page we fetched (tolerating typography and list bullets, nothing else). A field whose quote can't be found is reset to "unknown" and shown to you as something to read yourself. The engine never acts on an unquoted claim.
2. **Verdicts come from a rule engine, not a model.** `src/engine/eligibility.js` checks each member (location, residency status, student and employment status, age, employer) against each rule and returns the clause it relied on. It is plain code with tests for the cases that have misjudged real projects.
3. **Drafts can't overclaim.** Application kits cite the dossier as `[E3]`. A guard flags any number the dossier doesn't contain (matching whole numbers and units: a "40%" judging weight does not back "saved 40 hours"), citations to evidence that doesn't exist, and promises like "guaranteed to win".
4. **Web findings must cite a page.** The Investigator asks Gemini to read the event's own pages (URL context) and search the web (Google Search grounding). The API returns grounding supports: which span of the answer each cited page backs. We lay those spans over every sentence. A sentence is shown as a finding only if they cover all of its digits and at least 95% of its letters; anything else goes in a collapsed "without a source" list, never among the findings. A contradiction is shown only when each side is backed on its own, and a side backed only by a third-party page is flagged as such.

## Due diligence, with sources

Open an event and press **Investigate**. Gemini reads up to three of the event's known pages and runs a handful of Google searches, and the card comes back with:

- **Past editions**: how many people registered or submitted before, per year.
- **Judges and sponsors.**
- **Employee exclusions**: whose staff (sponsors, judges' employers, organisers) may not enter or win.
- **Contradictions between pages**, each side with its own source. One run on the Google Cloud AI Builder Cup found its themes page listing six industry themes in one section and a different five-category list in another. Both statements are on the same page, and the card says so.
- **Sources**, marked "event site" when they are the event's own pages.

The steps appear as they happen (reading and searching usually takes 10 to 60 seconds), and Google's Search Suggestions are shown with the card, as Grounding with Google Search requires. Because Google fetches the pages, this works even when Devpost's Cloudflare check refuses our server. A card holds only public facts about an event, so one card per event per day is shared by all visitors: a second click costs nothing. The rules engine never acts on the card; it is evidence for you to read.

## Architecture

```
                 Cloud Scheduler (02:30 SGT)
                          │
                          ▼
 Devpost API ──► Scout (Cloud Run Job) ──► Firestore: opportunities
 rules pages        clause patterns, no model          │
                                                       ▼
 Browser ──► Firebase Hosting (web client on Google's CDN; /api/** rewritten to Cloud Run)
                │
                ▼
             Cloud Run service (Node.js) ─────────────────────────────────────────────┐
              │  Profiler   GitHub API (first commit, licence, stars) + Gemini README summary (quotes verified)
              │  Clerk      Gemini structured extraction of rules → quote verification → unknown if unquoted
              │  Engine     deterministic eligibility per member + expected prize per registrant
              │  Investigator Gemini + URL context + Google Search grounding → supports laid over each sentence → unbacked ones set apart
              │  Coach      Gemini application kit → guard (numbers, citations, promises)
              │  Judges     Gemini, blind: sees only the kit and the official criteria
              │  Ledger     predictions before you commit; Brier score after results
              │  Progress   long model calls stream their steps to the browser (NDJSON over the same request)
              └─ Firestore: per-session dossiers, added events, predictions, daily AI budget, shared investigation cards
                 Vertex AI (Gemini, Google Search grounding, URL context) via the service account: no API keys in the container
```

| Piece | Where |
|:--|:--|
| Eligibility engine, company-family matching, ranking, guards | `src/engine/` |
| Quote verification | `src/quotes.js` |
| Gemini agents (Clerk, Profiler, Investigator, Coach, Judges) | `src/agents/` |
| Grounding check: supports laid over sentences, two-sided contradictions, source lookup | `src/agents/investigator.js` |
| Fetching with SSRF protection; GitHub; Devpost scout | `src/sources/` |
| API, per-session rate limits, token budgets, investigation caps, progress stream | `src/app.js` |
| Web client (no build step) | `web/` |
| Seed dataset (175 events, checked against official pages 28 Sep – 6 Oct 2026) | `data/opportunities.json` |
| Extraction eval: hand-labelled terms and the page snapshots they were checked against | `eval/` |

## Run it

```bash
npm install
npm test                       # 74 tests, no network, no model
npm start                      # http://localhost:8080 — rules engine only
GEMINI_API_KEY=... npm start   # with Gemini (or GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT)
npm run scan                   # pull open Devpost hackathons into data/scanned.json
npm run eval                   # extraction accuracy against eval/gold.json (needs Gemini)
```

The model defaults to the newest stable Gemini Flash the account can see; set `GEMINI_MODEL` to pin one.

## Deploy to Google Cloud

```bash
gcloud auth login
PROJECT_ID=your-project ./scripts/deploy.sh
```

The script enables the APIs, creates a Firestore database and a least-privilege service account, deploys the service and the nightly scan job to Cloud Run in `asia-southeast1`, and schedules the scan. Then put Firebase Hosting in front:

```bash
firebase deploy --only hosting --project your-project
```

`firebase.json` serves `web/` from Firebase Hosting and rewrites `/api/**` to the Cloud Run service. Hosting forwards only a cookie named `__session`, so that is the session cookie, and API answers are sent `Cache-Control: private, no-store` so the CDN never caches one session's data for another. Requests through Hosting time out after 60 seconds; the Cloud Run URL serves the same app without that limit. Grounding with Google Search and URL context need no role beyond `roles/aiplatform.user`. Set `GEMINI_MODEL` when deploying to pin a model.

Spending is capped per day: 400,000 tokens per session and 3,000,000 for the whole deployment (`AI_DAILY_TOKENS`, `AI_GLOBAL_DAILY_TOKENS`), 30 model calls per session per 10 minutes, and, because grounding is also billed per search query, 8 investigations per session and 40 for the deployment (`AI_SESSION_INVESTIGATIONS`, `AI_DAILY_INVESTIGATIONS`). The rules engine is never rate-limited.

## Evaluation

`eval/gold.json` holds eligibility terms we labelled by hand for five events: the AI Builder Cup terms, PayPal AI Hackathon, Build With AI: Basics, Qloo Agentic Hackathon and Meta VR START. That is 45 labelled fields. Each label was checked against a saved snapshot of the official page in `eval/snapshots/`, which is the exact text the model reads. Each label carries the sentence that justifies it, and `npm test` fails if any of those sentences is not in its snapshot word for word. Nine labels are traps, five of them with "unknown" as the only right answer. For example, the AI Builder Cup terms never give the prototype deadline, and the Basics rules require "the age of majority where they reside", which is not a number.

The eval reports:

- field accuracy;
- how many claims came with a quote we could verify;
- **confident errors**: wrong values that still carried a quote we could verify. This is the failure that would mislead a user.

We never changed a label after seeing a run. Each row is a single run at temperature 0. The asia-southeast1 endpoint lists only gemini-2.5-flash; the deployed service uses gemini-3.8-flash on the global endpoint.

| Run | Model (Vertex AI endpoint) | Events | Fields correct | Quotes verified | Confident errors | Traps passed |
|:--|:--|:--|:--|:--|:--|:--|
| 2026-10-08 | gemini-3.8-flash (global) | 2 | 17 / 17 | 14 / 14 | 0 | 1 / 1 |
| 2026-10-11 | gemini-2.5-flash (asia-southeast1) | 5 | 28 / 45 | 22 / 28 | 2 | 5 / 9 |
| 2026-10-11 | gemini-3.8-flash (global, production) | 5 | 42 / 45 | 31 / 35 | 0 | 9 / 9 |
| 2026-10-11, after fixes | gemini-2.5-flash (asia-southeast1) | 5 | 41 / 45 | 34 / 35 | 2 | 8 / 9 |
| 2026-10-11, after fixes | gemini-3.8-flash (global, production) | 5 | 45 / 45 | 31 / 32 | 0 | 9 / 9 |

The first five-event runs exposed three problems in the Clerk; none was in the labels:

1. A correct quote that ran across two list items never matched, because our HTML-to-text conversion puts each list item on its own line.
2. The judge-employer exclusion shared its quote with the sponsor-staff clause. A model could claim a judge clause the rules do not have and still pass verification; this was one of gemini-2.5-flash's confident errors.
3. One model copied 29,000 characters into a single quote and ran out of output.

All three are fixed. The "after fixes" rows use the same labels on the fixed code.

What remains:

- **gemini-2.5-flash's two confident errors** are misreadings backed by genuine quotes. It read "disclose any other pre-existing code" as allowing existing projects. It also read the definition of a "Team" as a minimum team size.
- **The production model's three misses in the first run** were claims it made without any quote. The Clerk resets such claims to "unknown" by design. They did not recur in the second run, but one run is not enough to call that fixed.

Full rows, including what the model claimed whenever a field was reset, are in `eval/results/`.

## Limits

- Not legal advice. For Singapore work-pass holders, the Ministry of Manpower has published no guidance on winning cash prizes; we say so rather than guess.
- Employer matching knows the big corporate families (Alphabet, Meta, Amazon and others). Smaller sponsors match by name only.
- The seed dataset reflects the official pages on the dates shown; rules change, so the app links every quote to its source.
- Devpost puts its rules pages behind a Cloudflare check for server traffic, so the nightly scout gets the open-event list (dates, prizes, registrant counts) but often not the rules text. For those events, Investigate reads the pages through Google, or paste the rules into "Add an event".
- The grounding check proves that Google's grounding ties a sentence to a cited page, not that the page says it correctly: read the source before you rely on it. Search results also vary from run to run (one run may find a contradiction another misses), which is why the card shows its searches and the pages it read.
- Gemini is asked for at most six searches per card and does not always comply: our capped runs used 4 to 8 (one run before the cap used 52). Published Google Docs and PDFs are left to search because reading one whole costs too many tokens (a published Doc came to 111,000).

## Built during the event

Every line in this repository was written after the team formed; see the first commit. The rule-engine design was prototyped on 5 October 2026, inside the official building window.

## License

Apache-2.0.
