# Rate limits on the OpenAI-compatible path

Applies to `OpenRouterProvider` — which also serves any OpenAI-compatible gateway configured
through `CLAUDE_MEM_OPENROUTER_BASE_URL`, not just openrouter.ai.

## The defect

Gateways in front of this path enforce a **rolling request ceiling**: once tripped, every
request is refused with `429` for a wall-clock window, regardless of remaining quota — a
2-token probe is refused just like a full generation. The window observed on one such gateway
is ~75 seconds: a probe one second after the first refusal still failed, the next one 74s later
succeeded.

Two things made that fatal rather than annoying:

- **The retry policy could not outlive the window.** `retry.ts` defaults are 2 retries from a
  100ms base — the attempts expire in under a second. Exponential backoff is the wrong shape
  here: a window that clears on wall-clock time is not approached by a curve, it is waited out.
- **Nothing paced the path.** Generators run one per session; several sessions generating at
  once fire as fast as the model answers, and each of them is well under any per-session limit
  because the limit is per account.

When the retries ran out, the generator threw, and the `catch` in `SessionRoutes.ts` drops the
in-RAM batch by design ("the transcript is the recovery path"). So a tripped ceiling cost whole
batches, repeatedly, for as long as the load lasted.

## The fix

**Fork-owned: `src/services/worker/call-pacer.ts`.** A `CallPacer` holding one process-wide
`nextSlotAt`, plus the `openRouterPacer` singleton every session's generator shares. `acquire()`
reserves its slot **synchronously, before its first `await`** — that is the whole trick, and the
reason it is not a copy of `GeminiProvider.enforceRateLimitForModel`, which re-reads a
module-level timestamp after waiting and therefore lets two concurrent callers wait the same
amount and then fire together. `defer(ms)` pushes the slot for *everyone*: the caller that gets
the 429 is not the only one that has to stop, since the ceiling is account-wide. The clock is
injectable so tests never sleep.

**Upstream `src/services/worker/retry.ts`** — three small, re-appliable edits:

1. `RetryOptions.rateLimitDelayMs` — the wall-clock window to wait on a `rate_limit` error that
   carries no `Retry-After`. Unset = previous behavior, so the Gemini path is untouched.
2. The delay branch: `rate_limit` now waits `Retry-After ?? rateLimitDelayMs`, plus up to 2s of
   jitter so sibling generators do not retry in lockstep. The clamp to
   `max(maxDelayMs, rateLimitDelayMs)` — a provider asking for an hour must not hang a
   generator for an hour — applies only to callers that configured a window; without one,
   `Retry-After` is still honored verbatim, so the Gemini path keeps its behavior (bar the
   ≤2s of jitter). Everything else keeps exponential backoff with jitter, unchanged.
3. `RetryOptions.sleepFn` — the inter-attempt sleep, extracted to `abortAwareSleep` and
   injectable. Same behavior by default; it exists so the tests can drive a simulated clock.

Non-retryable classes are untouched: `isRetryableKind` already stops on `auth_invalid`,
`unrecoverable` and `quota_exhausted`, and the tests pin that.

**Upstream `src/services/worker/OpenRouterProvider.ts`** — the retry callback is now a named
`attempt` closure run through `pacedAttempt()`, which acquires a slot before the call and defers
the shared budget after a refusal; `withRetry` receives `maxRetries` and `rateLimitDelayMs` from
settings. `queryOpenRouterMultiTurn` takes the config object instead of six positional
arguments, and `OpenRouterConfig` carries the four new fields.

**Upstream `src/shared/SettingsDefaultsManager.ts`** — four keys, declared and defaulted in the
same place and style as the Gemini switch:

| Setting | Default | Why that number |
|---|---|---|
| `CLAUDE_MEM_OPENROUTER_RATE_LIMITING_ENABLED` | `true` | On unless explicitly disabled — same posture as `CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED`. A refusal costs a whole batch. |
| `CLAUDE_MEM_OPENROUTER_MIN_REQUEST_INTERVAL_MS` | `1500` | ~40 calls/min across every session, roughly what a single generator sustains on its own — so one session barely notices, and N sessions cannot storm. |
| `CLAUDE_MEM_OPENROUTER_RATE_LIMIT_BACKOFF_MS` | `75000` | The measured recovery window. Anything shorter re-trips the ceiling and burns an attempt. |
| `CLAUDE_MEM_OPENROUTER_MAX_RETRIES` | `4` | ~5 minutes of patience. A replay harness needed 3 waits on a single stream; the fourth is headroom for sessions sharing one ceiling. |

Not added to `SettingsRoutes.ts` or the viewer settings modal — the fork's other OpenRouter keys
(`_BASE_URL`, `_QA_MODEL`) are not there either; this path is configured in `settings.json`.

## Deliberately out of scope

- **`KnowledgeAgent`'s corpus-query fetch** hits the same endpoint with no retry and no pacing.
  It is one interactive call per user question, so it contributes nothing to a storm — and
  pacing it would make an interactive query sit behind a 75s deferral caused by background work.
- **Aborts during a long wait.** `withRetry`'s sleep is abort-aware, but this path never passes
  an `abortSignal` (the session's controller does not reach `query()`; that would mean changing
  the abstract `query()` signature in `OpenAICompatibleProvider`). A session aborted mid-wait
  therefore keeps sleeping — the same as before the fix, over a longer window.
- **Server-beta `OpenRouterObservationProvider`** — separate runtime, not the fork default.

## Re-sync after an upstream merge

Re-apply, in order: the three `retry.ts` edits; `pacedAttempt` + the `withRetry` options +
the config plumbing in `OpenRouterProvider.ts`; the four keys in `SettingsDefaultsManager.ts`.
`call-pacer.ts` is fork-owned and merges cleanly. Guard: `bun test tests/openrouter-rate-limit.test.ts`
— it drives a simulated clock (no test sleeps) and asserts that the policy outlives a ~75s
outage, that the pre-fix policy does not, that `Retry-After` wins and is clamped, that
non-retryable classes fail on the first attempt, and that concurrent callers share one budget.
