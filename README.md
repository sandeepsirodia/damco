# Spec Clarity

Repo-aware feature-spec clarifier: a raw, messy feature ask + a target repo goes in;
clarifying questions grounded in that repo come back, then a grounded PRD/TRD with an
estimate, blast-radius read, and open-questions list. The whole thing runs as a chat —
describe the feature and point at a repo, answer the questions in normal conversation,
get the PRD/TRD back inline.

## Chat interface

`web/` is a React + Vite frontend built on two libraries, not hand-rolled:
[CopilotKit](https://copilotkit.ai) for the chat UI itself (message thread, streaming,
input box), and [shadcn/ui](https://ui.shadcn.com) for the stat tiles/tabs/badges inside
the results card. The assistant asks the repo-grounded clarifying questions as normal
chat messages — no form to fill in — and only the final PRD/TRD gets a richer rendered
card (tabs, grounded-file chips, a GitHub-push button).

The chat's own conversational routing is a thin layer: a `useCopilotAction` per pipeline
entry point (`startFeatureSpec`, `submitFeatureAnswers`, `pushToGithub`), each of whose
handler is a plain `fetch` to the **same, unchanged** REST API described below. The 9-stage
pipeline itself never talks to CopilotKit — it doesn't know a chat exists.

## Pipeline

1. **Repo Context Reader** — gitignore-aware file walk, README + manifest, no embeddings.
2. **Clarification Agent** — one LLM call, 4 fixed axes + 1 repo-grounded question.
3. **Blast-Radius Heuristic** — reference-count stand-in for a real dependency graph.
4. **Edge Case & Dependency Agent** — every finding must cite a real file or is marked ungrounded.
5. **Question Classifier** — tags open items PRODUCT_DECISION / ENGINEERING_DECISION / ASSUMPTION_MADE.
6. **Estimate Generator** — pure heuristic, driven by blast radius + unresolved/low-confidence items.
7. **Document Generator** — renders PRD (business) + TRD (technical) as markdown.
8. **Coverage Gate** — blocks if a finding never made it into the final docs.
9. **GitHub Write-back** — opt-in, PAT-gated, PAT used in-memory for one request only.

## Model-agnostic by design

The LLM layer (`src/llm/`) is a plain interface — `complete({system, user, json})` — with
one adapter per provider (`gemini.js`, `openai.js`, `anthropic.js`). Switching providers,
or the model within a provider, is a `.env` edit, never a code change:

```
LLM_PROVIDER=gemini        # or "openai" / "anthropic"
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.8-flash   # override to any Gemini model
```

Anyone running this just copies `env.example` to `.env`, drops in their own key for
whichever provider they want, and sets `LLM_PROVIDER` to match. No code touches provider
specifics outside `src/llm/<provider>.js`.

The chat layer's own conversational-routing model (`src/copilotkit.js`) reads the exact
same `LLM_PROVIDER`/`<PROVIDER>_MODEL`/`<PROVIDER>_API_KEY` vars — switching providers
changes both layers with one `.env` edit.

## Setup

One command brings up everything — Postgres and the app, both containerized,
migrations run automatically on boot:

```bash
cp env.example .env      # fill in LLM_PROVIDER + the matching API key
docker compose up -d --build
```

Open `http://localhost:3000`. `restart: unless-stopped` means it stays up across
reboots/crashes until you `docker compose down` it.

Note: **the app container does not hot-reload `.env`.** If you edit `.env` after it's
already running, run `docker compose up -d --build app` (or `docker compose restart app`
if you didn't change code, just env vars) to pick up the change.

If you'd rather run things directly on the host for faster iteration (only
containerize Postgres):

```bash
docker compose up -d db   # Postgres only, exposed on localhost:25432
npm install
npm run dev                # backend: node --watch, restart-free on code changes

cd web && npm install && npm run dev   # frontend: Vite dev server on :5173,
                                        # proxies /api to :3000 (see web/vite.config.ts)
```
With this split, point `DATABASE_URL` in `.env` at `localhost:25432` instead of the
container-internal `db:5432` docker-compose.yml uses for the containerized app. Open
`http://localhost:5173` (not :3000) when running this way — that's the Vite dev server
with hot reload; the Express server on :3000 only serves the last `npm run build` output.

## Tests

Pure-logic pieces (estimate math, coverage gate) have unit tests with no network or DB
dependency:

```bash
npm test
```

## Evals

Of the 4 LLM-calling *pipeline* stages, all 4 now have some form of correctness check --
plus a 4th suite covering the CopilotKit chat layer itself (a separate LLM call path none
of the pipeline suites touch, since they call `clarify.js`/`edgeCases.js`/etc. directly as
functions, bypassing the chat orchestration entirely). Layered by methodology
(deterministic/code-graded first, LLM-judge only for what code genuinely can't check --
see each suite's file header for the full rationale):

| Suite | Stage(s) | Method | Latest result |
|---|---|---|---|
| `eval/edge-case-grounding/` | Edge Case & Dependency Agent | deterministic | 18/18 fully grounded |
| `eval/doc-generator-grounding/` | Document Generator | deterministic | 17/18 fully grounded, 98.9% avg citation rate |
| `eval/question-quality/` | Clarification Agent + Question Classifier | deterministic (axis order, repo-finding grounding) + LLM-judge (distinct/specific/classifier-sound) | 18/18, 18/18, 18/18, 18/18, 17/18 |
| `eval/chat-agent/` | CopilotKit chat orchestration (`src/copilotkit.js` + `web/src/lib/chatAgent.js`) | deterministic (tool name/args, literal text patterns) | 18/18 checks across 4 scripted conversations |

The first three share the same 18 hand-authored cases and 3 repo fixtures (`eval/edge-case-grounding/cases.json` / `repo-fixtures.json`) rather than duplicating them, and the docs/questions suites reuse the edge-case suite's already-captured `findings` rather than re-spending that LLM call. `chat-agent` is different in kind: it drives the real `BuiltInAgent` (the same class + config `src/copilotkit.js` uses for `/api/copilotkit`) directly through scripted multi-turn conversations -- no HTTP, no browser -- stubbing only the tool *execution* (no live backend/DB/repo scan) so it stays fast while still exercising the real `INSTRUCTIONS` and tool schemas from `web/src/lib/chatAgent.js` (the single source of truth `App.tsx`'s `useCopilotAction` calls also import, so the eval can't silently drift from what's shipped). Every check is a deterministic predicate on tool-call args or a literal regex on response text (e.g. does a partial reply get the exact `✅ Answered (X/N)` / `❓ Remaining (Y/N)` template) -- no LLM judge in this suite, so it has none of the same-model-bias caveat below.

```bash
npm run eval             # edge-case-grounding: does every finding cite a real file?
npm run eval:docs        # doc-generator-grounding: does the actual PRD/TRD deliverable?
npm run eval:questions   # question-quality: axis structure + grounding + LLM-judge quality
npm run eval:chat        # chat-agent: does the conversational layer call the right tool,
                          # with the right args, and follow the fixed reply templates?
```

Each suite is harness-integrity-gated (editing the runner's grading logic requires
`--approve-harness` once, reviewed, so grading can't silently drift); the first three are
also resumable (re-running only does the (case, rep) pairs missing from `results.jsonl`) --
`chat-agent` is small/fast enough (4 conversations) that it just re-runs everything. The
CLI parsing/resume/backoff/timeout/harness-check machinery itself lives once in
`eval/lib/harness.mjs`, shared by `run-eval.mjs`/`run-doc-eval.mjs`/`run-question-eval.mjs`
rather than duplicated per suite -- each runner supplies only its own `loadCases`/`runCase`/
`gradeCase`/`perfFrom`.
Read `grade`/`explanation` straight out of each suite's `results.jsonl`, or per-case full
transcripts under `<suite>/baseline/traces/`.

**What's still unverified:** none of these suites check whether an estimate range is
*reasonable* given the findings, or whether the coverage gate's pass/fail is the right
call — those are deterministic code (`estimate.js`, `coverageGate.js`) with unit tests,
not LLM output, so "correct" there means "matches the documented heuristic," which the
unit tests already do (`npm test`). What's genuinely unverified is prose *quality* beyond
grounding: is a PRD's problem statement actually well-framed, is an edge-case finding's
severity sensible. That needs either a broader LLM-judge rubric or human review — not
built here.

**Known limitations**, both inherited across the first three (pipeline) suites -- neither
applies to `chat-agent`, which has no judge and, via `BuiltInAgent`, does get real
token/cost data (just not yet wired into its `results.jsonl`): (1) the LLM provider
adapters return only completion text, not token usage, so no cost/token columns; (2) the
`question-quality` judge grades output from the same provider/model it's judging (no
independently-configured second model exists in this model-agnostic-by-design app) — a
same-model bias risk, mitigated by requiring the judge to cite specific evidence per
score rather than a bare number, so a human can spot-check disagreement.

## Observability (optional)

Every pipeline-stage LLM call (`clarify`, `edgeCases`, `classifier`, `docGenerator`) can be
traced to [Langfuse](https://langfuse.com) — prompt, completion, latency, and errors per
call, with all four stages from one request nested under a single "intake" or "analysis"
trace (see `src/routes/sessions.js`). Wired once at the single choke point every LLM call
already goes through (`complete()` in `src/llm/index.js`), so no pipeline stage file needed
touching beyond passing its own name for labeling.

Entirely opt-in, same posture as `COPILOTKIT_TELEMETRY_DISABLED`: leave `LANGFUSE_PUBLIC_KEY`
/ `LANGFUSE_SECRET_KEY` blank in `.env` and nothing here runs — `startObservation()` calls
become no-ops (an OpenTelemetry guarantee, not something this app has to special-case).

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=http://localhost:3001   # or https://cloud.langfuse.com
```

Get keys from your Langfuse project's Settings → API Keys. Rebuild/restart the app after
editing `.env` (see the hot-reload note above).

**Scope**: this traces the 9-stage pipeline's own LLM calls. It does not trace CopilotKit's
own conversational-routing model (`src/copilotkit.js`) — that's a separate LLM call path
(deciding which tool to call next) that CopilotKit's runtime owns, not something
`complete()` sees.

**Why this matters beyond dashboards**: it's the practical link to the eval suites above —
a trace Langfuse captures in production is a real, ungraded case; promoting the interesting
ones (a user-flagged bad answer, a long-tail repo shape none of the 18 hand-authored cases
cover) into `eval/*/cases.json` is how the eval suites grow past what was anticipated
up front, which is exactly where hand-authored cases run out.

## Built fully vs. designed-only

**Built fully:** all 9 pipeline stages, Postgres persistence, the model-agnostic LLM
interface with Gemini/OpenAI/Anthropic adapters, a CopilotKit + shadcn/ui chat frontend,
Docker + docker-compose (multi-stage: builds `web/`, then the server) + one CI workflow,
GitHub Issue write-back, 3 eval suites covering all 4 LLM-calling stages, optional
Langfuse tracing across the whole pipeline.

**Designed, not built:** a real dependency graph (madge/dependency-cruiser) in place of
the blast-radius grep heuristic; deep repo embeddings/semantic search; a local LLM
(Ollama) adapter — the provider interface supports it, it's just not wired up.

## Security

- GitHub PAT is read from the request body, used for that one call, and never written
  to disk or the database. **This covers this app's own storage only** — the chat flow
  collects the PAT through normal conversation (see `web/src/lib/chatAgent.js`'s
  `INSTRUCTIONS`), and a chat-collected value has to be passed back as a tool-call
  argument for `pushToGithub` to run at all. That means the plaintext PAT transits
  whichever LLM provider is configured (Gemini/OpenAI/Anthropic) before it ever reaches
  this backend. There's no way to route around that within a tool-calling chat
  architecture without a separate out-of-band input path (e.g. a form field the chat
  never sees) — not implemented here. If that's unacceptable for a given deployment,
  don't collect the PAT through chat; add a dedicated field instead.
- `GET /api/fs/list` (the header folder picker) is confined to `FS_BROWSE_ROOT` (or the
  server's home directory if unset) — it will refuse to list anything outside that root.
- `.env*` files are excluded from the Docker build context and git.
- No rate-limiting is implemented — add it before a hosted deployment.
