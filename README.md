# No Fine Print

**Which competitions can your team actually win?** No Fine Print reads the rules of hackathons, grants and innovation challenges, checks every member of your team against them, quotes the clause behind every verdict, and ranks what is left by prize money per entrant. Then it drafts an application that cannot overclaim.

Built for the Google Cloud AI Builder Cup 2026 (theme: Future of Work & Enterprise Productivity).

## The problem

Small teams pick competitions with almost no decision support. Eligibility rules are scattered across microsites, FAQs and terms documents that change without notice, and the clauses that disqualify you are the ones nobody reads:

- a teammate doing a part-time master's degree gets the whole team disqualified ("Full-time or part-time students are strictly ineligible");
- a prototype written in August, published on GitHub in September, is still "pre-existing" for an event whose build window opened in between;
- a teammate who works for the sponsor can't compete for prizes, even when the event's own terms never say so.

In our seed dataset, 98 of 113 open competitions had at least one condition (residency, student status, or whether existing work counts) that our first research pass could not pin down from the official pages. And prize pools mislead: across the 25 events where both the pool and the registrant count are public, the expected prize per registrant ranges from S$0.55 to S$2,322.

## How it decides

Gemini reads; code decides. Three rules hold everywhere:

1. **Every claim about the rules must quote the rules.** When Gemini extracts an eligibility field, it must copy the sentence that states it. We then look for that sentence in the page we fetched (tolerating typography, nothing else). A field whose quote can't be found is reset to "unknown" and shown to you as something to read yourself. The engine never acts on an unquoted claim.
2. **Verdicts come from a rule engine, not a model.** `src/engine/eligibility.js` checks each member (location, residency status, student and employment status, age, employer) against each rule and returns the clause it relied on. It is plain code with tests for the cases that have misjudged real projects.
3. **Drafts can't overclaim.** Application kits cite the dossier as `[E3]`. A guard flags any number the dossier doesn't contain (matching whole numbers and units: a "40%" judging weight does not back "saved 40 hours"), citations to evidence that doesn't exist, and promises like "guaranteed to win".

## Architecture

```
                 Cloud Scheduler (02:30 SGT)
                          │
                          ▼
 Devpost API ──► Scout (Cloud Run Job) ──► Firestore: opportunities
 rules pages        clause patterns, no model          │
                                                       ▼
 Browser ──► Cloud Run service (Node.js) ─────────────────────────────────────────────┐
              │  Profiler   GitHub API (first commit, licence, stars) + Gemini README summary (quotes verified)
              │  Clerk      Gemini structured extraction of rules → quote verification → unknown if unquoted
              │  Engine     deterministic eligibility per member + expected prize per registrant
              │  Coach      Gemini application kit → guard (numbers, citations, promises)
              │  Judges     Gemini, blind: sees only the kit and the official criteria
              │  Ledger     predictions before you commit; Brier score after results
              └─ Firestore: per-session dossiers, added events, predictions, daily AI budget
                 Vertex AI (Gemini) via the service account: no API keys in the container
```

| Piece | Where |
|:--|:--|
| Eligibility engine, company-family matching, ranking, guards | `src/engine/` |
| Quote verification | `src/quotes.js` |
| Gemini agents (Clerk, Profiler, Coach, Judges) | `src/agents/` |
| Fetching with SSRF protection; GitHub; Devpost scout | `src/sources/` |
| API, per-session rate limits and token budget | `src/app.js` |
| Web client (no build step) | `web/` |
| Seed dataset (175 events, checked against official pages 28 Sep – 6 Oct 2026) | `data/opportunities.json` |
| Extraction eval with hand-labelled terms | `eval/` |

## Run it

```bash
npm install
npm test                       # 43 tests, no network, no model
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

The script enables the APIs, creates a Firestore database and a least-privilege service account, deploys the service and the nightly scan job to Cloud Run in `asia-southeast1`, and schedules the scan.

## Evaluation

`eval/gold.json` holds terms we labelled by hand against the official pages. The eval reports field accuracy, how many claims came with a verifiable quote, and **confident errors**: wrong values that still carried a quote we could verify, the failure that would mislead a user. One label is a trap on purpose: the AI Builder Cup terms never state the prototype deadline, so the correct answer is "unknown".

## Limits

- Not legal advice. For Singapore work-pass holders, the Ministry of Manpower has published no guidance on winning cash prizes; we say so rather than guess.
- Employer matching knows the big corporate families (Alphabet, Meta, Amazon and others). Smaller sponsors match by name only.
- The seed dataset reflects the official pages on the dates shown; rules change, so the app links every quote to its source.

## Built during the event

Every line in this repository was written after the team formed; see the first commit. The rule-engine design was prototyped on 5 October 2026, inside the official building window.

## License

Apache-2.0.
