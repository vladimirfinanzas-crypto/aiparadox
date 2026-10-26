# AI providers

Paradox runs on five AI providers behind one router. OpenRouter stays first; the
other four exist so a chat or agent turn keeps working when OpenRouter's free
quota is spent.

The original failure was OpenRouter's per-key daily allowance for free models:

```
AI_APICallError: Rate limit exceeded: free-models-per-day.
Add 10 credits to unlock 1000 free model requests per day
```

That is not a burst limit — every free model on that key answers `429` until
midnight UTC. The old code retried the next OpenRouter model, which hit the same
key and the same cap. The router now recognises the error, stops calling
OpenRouter for the day, and answers from the next eligible provider.

## Architecture

```
lib/ai/
  types.ts              provider ids, capabilities, AI SDK call shapes
  models.ts             model catalog, role requirements, env overrides
  provider-registry.ts  the only place provider adapters are looked up
  providers/
    openrouter.ts       @openrouter/ai-sdk-provider
    gemini.ts           @ai-sdk/google
    cerebras.ts         @ai-sdk/cerebras
    groq.ts             @ai-sdk/groq
    cloudflare.ts       @ai-sdk/openai-compatible → Workers AI
  quota-manager.ts      cooldowns, metrics, provider-specific units
  fallback.ts           error classification, backoff, failure errors
  model-router.ts       capability filtering, fallback, streaming, cancellation
  observability.ts      one structured log line per model request
```

`lib/model.ts` keeps the names the rest of the app already imports
(`chatModel`, `roleModel`, `getRoutingModel`, `MODEL_CONFIG`, `MODEL_LADDERS`)
and delegates to the router, so the chat task, the agent router, the agent
builder and the dashboard did not have to be rewritten.

Provider adapters are the only place a provider SDK is touched. Adding a
provider is one file plus one registry entry; agent business logic stays out of
it.

## Credentials

Every key is read server-side from `process.env`. No provider key is exposed in a
`NEXT_PUBLIC_*` variable, a client component or an API response. The health
endpoint returns booleans and variable *names* only.

| Variable | Provider | Where to get it | Notes |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter | <https://openrouter.ai/keys> | Scoped API key. Free models: 50 requests/day per key, 1000/day once the account holds 10 credits. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API | <https://aistudio.google.com/apikey> | Key from Google AI Studio. `GOOGLE_API_KEY` is accepted as a fallback name. Not a Vertex key. |
| `CEREBRAS_API_KEY` | Cerebras Inference | <https://cloud.cerebras.ai/> | API key from the Cerebras console. Free trial is credit- and token-bounded, not a permanent request quota. |
| `GROQ_API_KEY` | Groq | <https://console.groq.com/keys> | Standard API key. Limits per organisation are shown in the console. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | Cloudflare dashboard → account | The account that owns Workers AI. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare | <https://dash.cloudflare.com/profile/api-tokens> | Token with **Workers AI: Read**. Edit is only needed for deploying Workers with the same token. |

Optional:

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_BACKSTOP_MODEL` | Appends a stronger (usually paid) OpenRouter model to every ladder, last. Naming one is the explicit authorization to use it. Off by default. |
| `PARADOX_PROVIDER_ORDER` | Default `openrouter,gemini,cerebras,groq,cloudflare`. |
| `PARADOX_DISABLED_PROVIDERS` | Comma-separated providers to skip without deleting keys. |
| `PARADOX_MODEL_<ROLE>` | Put a model first for a role, e.g. `PARADOX_MODEL_GENERAL=gemini:gemini-3.8-flash`. Roles: `GENERAL`, `FAST`, `CODE`, `REASONER`, `CREATIVE`, `VISION`, `EVALUATOR`. A bare id means OpenRouter. |
| `PARADOX_ALLOW_PAID_MODELS` | `true` only if a paid model may be used outside the explicit backstop. Default off. |
| `PARADOX_AI_MAX_PROVIDER_CALLS` | Hard cap on provider calls per request. Default `6`. |
| `PARADOX_AI_MAX_RETRIES` | Retries of the same model for a transient failure. Default `1`. |
| `PARADOX_COOLDOWN_RATE_LIMIT_MS` | Default cooldown after a temporary 429. Default `30000`. |
| `PARADOX_COOLDOWN_QUOTA_MS` | Cooldown when a daily reset is unknown. Default one hour. |
| `PARADOX_COOLDOWN_OUTAGE_MS` | Cooldown after a 5xx. Default `60000`. |
| `PARADOX_COOLDOWN_UNSUPPORTED_MS` | Cooldown for a model the account cannot run. Default ten minutes. |

The application starts and works with any subset of keys. A provider with no
credentials is skipped by the router; nothing throws at import time.

### Local setup

1. Copy `.env.example` to `.env.local`.
2. Fill in the keys you have. `.env.local` is git-ignored (`.env*` in
   `.gitignore`, with `!.env.example` so the template can be committed).
3. Restart the dev server (`npm run dev`). Next.js reads env files at boot;
   changes are not picked up by a running server.

`OPENROUTER_API_KEY` may live in `.env` instead of `.env.local` — this project
already keeps it there. Do not add an empty `OPENROUTER_API_KEY=` line to
`.env.local`: `.env.local` is loaded with higher precedence, so an empty entry
can mask the working key.

### Deployment

`.env.local` is never uploaded. Set the same variables in the deployment
platform's environment settings, and in Trigger.dev's dashboard for the tasks
that call models (`trigger/init.ts` logs the provider report there at boot).
Production and preview environments are configured separately.

## Model catalog

Capabilities are only marked where the provider documents them. The router
filters by capability before a provider is called, so a task that needs tool
calling, JSON schema output or image input never lands on a model that cannot do
it.

| Role | OpenRouter (first) | Gemini | Cerebras | Groq | Cloudflare |
| --- | --- | --- | --- | --- | --- |
| `general` | `nvidia/nemotron-3-ultra-550b-a55b:free` | `gemini-3.6-flash` | `gpt-oss-120b` | `openai/gpt-oss-120b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `fast` | `nvidia/nemotron-3.5-lightning:free` | `gemini-3.5-flash-lite` | `gpt-oss-120b` | `openai/gpt-oss-20b` | `@cf/zai-org/glm-4.7-flash` |
| `code` | `nvidia/nemotron-3-ultra-550b-a55b:free` | `gemini-3.6-flash` | `gpt-oss-120b` | `openai/gpt-oss-120b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `reasoner` | `nvidia/nemotron-3-ultra-550b-a55b:free` | `gemini-3.6-flash` | `gpt-oss-120b` | `openai/gpt-oss-120b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `creative` | `dots-studio/dots-3-note-preview:free` | `gemini-3.6-flash` | `qwen-3.8-27b` | `openai/gpt-oss-120b` | `@cf/zai-org/glm-4.7-flash` |
| `vision` | `nvidia/nemotron-3.5-super-vl:free` | `gemini-3.6-flash` | `qwen-3.8-27b` | `qwen/qwen3.8-27b` | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| `evaluator` | `dots-studio/dots-3-note-preview:free` | `gemini-3.1-flash-lite` | `gpt-oss-120b` | `openai/gpt-oss-20b` | — (JSON mode only) |

Each role also has additional rungs inside each provider (`lib/ai/models.ts`);
the table shows the primary of each.

Capability notes:

- **OpenRouter** — every id was checked against the live catalogue
  (`https://openrouter.ai/api/v1/models`, October 2026). `nemotron-3-ultra`,
  `nemotron-3.5-lightning` and `gemma-4-31b-it` advertise `tools` but **not**
  `structured_outputs` (strict `json_schema`); only `dots-3-note-preview` and
  `nemotron-3.5-super-vl` do. The catalog marks the first three for loose JSON
  only, so a strict-schema call is never planned onto them — they stay fully
  usable for ordinary chat turns. `gemma-4-31b-it` replaced MiniMax M3.1 Flash,
  whose free variant was retired.
- **Gemini** — `gemini-3.6-flash` leads the general, code and vision ladders;
  `gemini-3.8-flash` is the second rung because live checks returned "this model
  is currently experiencing high demand" from it repeatedly, while 3.6 answered
  every check. `gemini-3.5-flash-lite` serves fast/browser turns and
  `gemini-3.1-flash-lite` the JSON routing role. All four document function
  calling, structured output, streaming and image input. `gemini-4-argon` and
  `gemini-3.1-pro-preview` have no free tier and are deliberately absent.
  `thinkingConfig.thinkingLevel` is set to `low` for interactive roles (Gemini 3
  otherwise spends its first-output deadline thinking) and `medium` for code and
  reasoning. Free-tier RPM/RPD vary by model, project and account.
- **Cerebras** — shared inference offers `gpt-oss-120b` (tools, JSON schema,
  streaming, no images) and `qwen-3.8-27b` (adds image input). Context is
  65K/64K on the free trial. Deprecated ids (`llama-3.3-70b`, `qwen-3-32b`) are
  not used.
- **Groq** — the account's live catalogue is GPT-OSS and Qwen only;
  `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` and
  `meta-models/muse-spark-open` were not available, so they are not in the
  catalog. `openai/gpt-oss-120b` and `openai/gpt-oss-20b` support tools, strict
  `json_schema` and streaming; `qwen/qwen3.8-27b` is the vision model.
  `reasoningEffort: low` is set for interactive roles, because GPT-OSS otherwise
  spends output tokens purely on reasoning.
- **Cloudflare** — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (function calling),
  `@cf/zai-org/glm-4.7-flash` (multi-turn tool calling),
  `@cf/meta/llama-4-scout-17b-16e-instruct` (vision + function calling). Two live
  findings are handled here: Workers AI streams a generated number as a JSON
  number (`{"delta":{"content":1}}`), which the OpenAI-compatible schema rejects,
  so the adapter repairs those SSE frames before the SDK parses them; and JSON
  mode cannot honour a strict schema (one check returned a function-shaped
  object), so these models are deliberately **not** marked for structured output.
  Workers AI's Neuron cost is read from each response and tracked as Neurons,
  never mixed with token counts or request counts.

Model ids are configuration, not constants: replace them in
`lib/ai/models.ts` or override a role with `PARADOX_MODEL_<ROLE>` when a catalog
changes. Free tiers are never assumed to be permanent.

## Routing and agent behaviour

| Agent kind | Role | Why |
| --- | --- | --- |
| `chat`, `default` | `general` | Conversation, tool use, structured replies. |
| `browser` | `fast` | Quick tool-calling steps; the ladder ends on stronger models when the fast rung stalls. |
| `computer` | `vision` | Screenshot analysis needs documented image input. |
| `social` | `creative` | Copywriting and social formats, with a reasoner-quality fallback. |
| Code work | `code` | Coding and technical reasoning, with tools and JSON. |
| Routing / agent drafting | `evaluator` | Strict JSON schema only; no tools needed. |

Images in a prompt raise the requirement to vision at call time
(`promptHasImage`), even for a text role, so a screenshot is never sent to a
model that cannot read it and never silently dropped.

Structured output is requested only where it is used: `evaluator` for routing
and `structuredChatModel()` for drafting agents. Ordinary chat and agent turns
need tools, not a schema, which is why a tools-only model such as Workers AI can
still answer a conversation.

The evaluator's rungs are `2s, 1s, 1s` on purpose: `pickAgent` gives the whole
routing decision 4.5s (`ROUTING_DEADLINE_MS`), so rungs adding up to more than
that could never reach a fallback — the outer signal aborted the ladder during
its first attempt. `lib/ai/__tests__/routing-budget.test.ts` keeps that invariant
true if either number changes.

## Fallback rules

1. Candidates are ordered by provider (`openrouter` → `gemini` → `cerebras` →
   `groq` → `cloudflare`) and then by the role's ladder.
2. A provider without credentials, in cooldown, or with rejected credentials is
   skipped before any call.
3. If OpenRouter answers `free-models-per-day`, the daily quota is recorded for
   that key, the request moves to the next provider immediately, and later
   requests skip OpenRouter until the reset. No retries against the exhausted
   allowance.
4. A transient `429` (no daily signal) is retried once on the same model,
   honouring `Retry-After`, then that model gets a short cooldown. The rest of
   the provider's models stay in rotation: a per-minute limit on one model is
   not treated as an exhausted account.
5. A `5xx` or network failure is retried once with exponential backoff and
   jitter, then the provider gets a one-minute cooldown.
6. An auth failure (401, invalid key) blocks that provider until the credentials
   change (detected by a short fingerprint) or the process restarts.
7. A model the account cannot run (404, paid-only, model agreement) cools down
   that model only, and the next candidate is tried.
8. Timeouts: each attempt has a deadline for its **first** output. A model that
   has started answering is never interrupted.
9. If nothing is eligible, the caller gets one clear temporary-unavailability
   error: `No AI provider could answer the <role> request right now. …`

Paid models are never selected by fallback. The only paid rung is
`OPENROUTER_BACKSTOP_MODEL`, and only when an operator sets it.

## Quota manager

`lib/ai/quota-manager.ts` tracks per provider: attempts, successes, failures,
rate-limit errors, quota errors, auth errors, last failure, cooldown expiry,
latency, token usage and cost (when the provider returns them).

- Remaining free quota is **not** invented. `remainingQuotaKnown` is always
  `false`; only signals the provider actually sent are stored.
- Units are kept apart. OpenRouter and Groq count requests, Cerebras counts
  tokens, Workers AI counts **Neurons**. Cloudflare's 10,000 free Neurons/day are
  never treated as a request count.
- Storage defaults to process memory behind a `QuotaStore` interface
  (`setQuotaStore`). Trigger.dev task processes are long-lived, so cooldowns work
  there. In a serverless Next.js deployment each instance has its own copy and a
  cooldown learned by one instance is not shared; point `setQuotaStore` at Redis,
  D1 or the Postgres usage ledger if that matters. `quotaReport()` exposes the
  current state for diagnostics.

## Streaming and cancellation

- Before the first output, a provider failure falls back to the next candidate;
  nothing has been shown yet, so this is lossless.
- After output has started, no other provider is tried. The failure is emitted as
  the final `error` stream part and the stream closes, so the partial answer is
  kept, the failure is reported, and nothing is duplicated.
- Client cancellation is propagated through `AbortSignal`; the active provider
  reader is cancelled exactly once and listeners are removed. Each attempt
  attaches and detaches its own listener, so a long tool-using turn cannot pile
  up listeners on the caller's signal (the previous source of
  `MaxListenersExceededWarning`).

## Observability

One structured line per model request:

```
[ai.request] {"role":"general","agentKind":"chat","requestId":"…","provider":"gemini",
"model":"gemini-3.8-flash","latencyMs":812,"usedFallback":true,
"fallbackFrom":"openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
"fallbackReason":"quota_exhausted","attempts":2,"inputTokens":342,"outputTokens":88}
```

Never logged: API keys, prompts, message content, tool arguments, model output.
Error messages are truncated to 300 characters and redacted (`sk-…`,
`Bearer …`, `api_key=…`).

Startup logs one line naming configured and missing providers:

```
[ai] AI providers: openrouter=ready, gemini=skipped(GOOGLE_GENERATIVE_AI_API_KEY), …
```

## Diagnostics

- `GET /api/ai/health` (signed in) — OpenRouter catalogue check, per-provider
  configuration, the routing plan for each role (including capability gaps),
  quota state, and today's OpenRouter free allowance.
- `GET /api/ai/health?probe=1` — additionally sends one tiny completion per
  configured **provider** (through that provider's own adapter, so a cooldown
  learned earlier cannot hide its real state) and per OpenRouter model. This
  spends a few free requests, so it is opt-in.
- Settings → Integrations → AI models shows the plan and can run the probe.

The probe is **bounded**: a 4 s cap per call and an 8 s budget for the whole
phase, so the request still fits in a Netlify synchronous function (a few
seconds). Anything that does not fit comes back with `status: "skipped"` and
`error: "probe budget spent"` instead of a 502 with no diagnosis. The budget is
reported in the response as `probeBudgetMs`.

### What the person is told when nothing answers

The router's final error is not one sentence for every cause. Its `reason` field
(and the message) distinguishes four cases, because they need different actions:

| Reason | Message says | What to do |
| --- | --- | --- |
| `none_configured` | "No AI provider is configured…" | Set a provider key **in the deployment and in the Trigger.dev worker**. |
| `auth_failed` | "Every configured AI provider rejected its credentials…" | Replace the keys that answer 401. Retrying cannot fix it. |
| `no_eligible_model` | "No configured model can run the <role> request: every catalogued model lacks …" | Fix the catalog, or pin a capable model with `PARADOX_MODEL_<ROLE>`. |
| `all_failed` | "No AI provider could answer the <role> request right now…" | Capacity/quota. Trying again later is the right move. |

The chat panel maps these to its own toasts (`aiFailureCodeOf` in
`lib/ai/fallback.ts`), so a missing variable is never described as "the model did
not answer". A missing `TRIGGER_SECRET_KEY` is caught in the server action before
any model is reached, and says so.

## Tests

```bash
npm test        # mocked providers, no quota is spent
npm run typecheck
npm run lint
npm run build

# Opt-in: one real, tiny completion per configured provider. Verifies the model
# ids and the credentials against the live APIs; a rate limit is reported, not
# failed. Never runs as part of `npm test`.
PARADOX_LIVE_PROVIDER_TESTS=1 npx vitest run lib/ai/__tests__/providers.live.test.ts
```

The suite covers: a successful OpenRouter request, the `free-models-per-day`
fallback, Gemini/Cerebras/Groq/Cloudflare fallback, missing credentials, invalid
keys, timeouts, transient 429 versus daily exhaustion, all providers failing,
tool/structured-output filtering, vision routing, stream failure before and after
first output, client cancellation, concurrent requests, and the Workers AI
numeric-chunk repair. It runs entirely against mocks and spends no real quota.

Live verification is the opt-in test above, so it can never spend a free tier in
CI. A production `next start` boot with all keys set logs:

```
[ai] AI providers: openrouter=ready, gemini=ready, cerebras=ready, groq=ready, cloudflare=ready
```

## Status and remaining manual steps

All five providers are configured locally in `.env.local` and were checked with
real requests (October 2026). Each check used the smallest possible prompt:

| Provider | text | tools | structured | vision | streaming |
| --- | --- | --- | --- | --- | --- |
| OpenRouter | quota exhausted (`free-models-per-day`) | — | — | — | — |
| Gemini (`3.6-flash`, `3.1-flash-lite`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cerebras (`gpt-oss-120b`, `qwen-3.8-27b`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Groq (`gpt-oss-120b`, `qwen3.8-27b`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cloudflare (`llama-3.3-70b`, `llama-4-scout`) | ✅ | ✅ | refused by design | ✅ | ✅ |

A real `chatModel("chat")` turn with OpenRouter's free quota exhausted answered
from Gemini (`FALLBACK OK`), which is the failure mode this change exists for.
A second request in the same process made zero OpenRouter calls, proving the
daily cooldown prevents retrying an exhausted key.

Verification method in this pass, so the claims above are traceable:

- Every model id was re-checked against **OpenRouter's live catalogue endpoint**
  (`/api/v1/models`, including each model's `supported_parameters`) and against
  the four other providers' official documentation. All ids exist; three
  OpenRouter models were over-claiming strict JSON and were corrected.
- **Retry stacking was measured and ruled out.** The AI SDK defaults to
  `maxRetries: 2`, which would multiply a 6-call ladder by three. It does not
  fire here: the router throws its own `AllProvidersFailedError`, which is not an
  `APICallError`, so the SDK does not consider it retryable. One routed request
  is one bounded ladder (`PARADOX_AI_MAX_PROVIDER_CALLS`, default 6).

Remaining notes:

- Keys pasted into a chat are exposed to that transcript. Rotate them in each
  provider console when convenient, then update `.env.local` and the deployment
  settings; the code reads the values at runtime, so only a restart is needed.
- Cloudflare structured output stays disabled until its schema mode is verified
  against the models you actually use. Its JSON mode is documented as
  best-effort, and a live request returned a function-shaped object.
- `gemini-3.8-flash` was intermittently answering "currently experiencing high
  demand". That is why 3.6 leads the ladder and why a 5xx now cools down only the
  affected model, not the whole provider.
- Free-tier limits and model ids change. Check the provider catalogs linked above
  before relying on a specific model, and update `lib/ai/models.ts` or use
  `PARADOX_MODEL_<ROLE>`.
- Cloudflare's `@cf/meta/llama-3.2-11b-vision-instruct` requires accepting Meta's
  terms once (`prompt: "agree"`); the catalog uses `llama-4-scout` instead.
- Trigger.dev needs the same environment variables for tasks; the Next.js app and
  the Trigger worker are configured separately.
