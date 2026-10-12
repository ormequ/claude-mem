# Rate limits on the OpenAI-compatible paths

Applies to both HTTP providers that speak `/chat/completions`:

- `OpenAICompatProvider` (`CLAUDE_MEM_PROVIDER=openai-compatible`) — upstream's provider for any
  OpenAI-shaped endpoint, with its own `CLAUDE_MEM_OPENAI_COMPAT_*` keys and key pool. This is
  the fork's default provider and the path the memory generator runs on.
- `OpenRouterProvider` (`CLAUDE_MEM_PROVIDER=openrouter`) — openrouter.ai, or any gateway set
  through `CLAUDE_MEM_OPENROUTER_BASE_URL`. Kept protected for installs still configured on it.

## The defect

Gateways in front of these paths enforce a **rolling request ceiling** per account: once
tripped, every request is refused with `429` for a wall-clock window, regardless of remaining
quota — a 2-token probe is refused just like a full generation. The window observed on one such
gateway is ~75 seconds: a probe one second after the first refusal still failed, the next one
74s later succeeded.

Upstream's policy cannot outlive that window: a `429` without `Retry-After` gets 2 in-place
retries on a 1s→30s exponential curve (a few seconds in total), and a `Retry-After` is capped at
60s. Exponential backoff is the wrong shape here — a window that clears on wall-clock time is
not approached by a curve, it is waited out. And nothing paces the path: generators run one per
session, so several sessions generating at once fire as fast as the model answers, each well
under any per-session limit, because the limit is per account.

Upstream now pauses the session with its buffered work kept when a rate limit outlives the
retries (`preservingAbortReason` → `rate_limit:` → the resume scheduler), so a tripped ceiling
no longer drops batches outright the way it did before. It still costs a pause/resume cycle per
session per trip, and the storm itself is not prevented — hence the fork patch.

## The fix

**Fork-owned: `src/services/worker/call-pacer.ts`.**

- `CallPacer` holds one process-wide `nextSlotAt`. `acquire()` reserves its slot
  **synchronously, before its first `await`** — the reason it is not a copy of
  `GeminiProvider.enforceRateLimitForModel`, which re-reads a module-level timestamp after
  waiting and so lets two concurrent callers wait the same amount and fire together.
  `defer(ms)` pushes the slot for *everyone*: the ceiling is account-wide. Injectable clock.
- `openRouterPacer` and `openAICompatPacer` — one shared pacer per provider.
- `resolvePacingPolicy(settings, prefix)` reads the four `<prefix>_*` keys below.
- `pacedRetryOptions(policy)` — the `withRetry` options (`maxRetries`, `rateLimitDelayMs`).
  Empty when rate limiting is off, so `..._RATE_LIMITING_ENABLED=false` means upstream's retry
  policy, untouched.
- `pacedAttempt(pacer, policy, poolSize, attempt)` — acquire a slot, run the attempt, and on a
  `rate_limit` defer the shared pacer by `Retry-After ?? window`, capped at
  `max(60s, window)` so a provider asking for an hour cannot park the pacer longer than the
  retry it precedes.

**Composition with upstream's key pool** (`src/shared/api-key-pool.ts`, unchanged). Rotation
wraps `withRetry`; with a pool of more than one key, `retryPolicyForPool` makes `rate_limit`
non-retryable in place, so a 429 rotates to the next key and the pool parks the throttled key
(its own per-key cooldown, `Retry-After` or 60s). The fork composes with that, not against it:

- Pacing (the minimum interval) applies to every send, whichever key — one global pacer per
  provider. Ceiling: with keys on *different* accounts this under-uses the extra capacity;
  per-account pacers would fix that if it ever matters.
- The account-wide deferral happens **only when the pool has nowhere to rotate** (`poolSize`
  ≤ 1). With a second key, holding everyone off for 75s would stall the very rotation that
  sidesteps the window. When every key is spent, the pool rethrows the last `rate_limit` and
  upstream's pause path takes over.
- The in-place window wait (`rateLimitDelayMs`) therefore only ever fires on a single-key pool —
  the measured gateway case (one account, one key).

**Upstream `src/services/worker/retry.ts`** — re-applied on top of upstream's
never-pay-twice rewrite:

1. `RetryOptions.rateLimitDelayMs` — the window to wait on a `rate_limit` without
   `Retry-After`. Unset = upstream's behavior.
2. The delay branch: a `rate_limit` from a caller that configured a window waits
   `Retry-After ?? window`, plus up to 2s of jitter (anti-lockstep), capped at
   `max(MAX_RETRY_AFTER_MS, window)`. Callers without a window keep upstream's rule verbatim
   (`Retry-After` capped at 60s, else exponential backoff, no extra jitter).
3. `RetryOptions.sleepFn` — the inter-attempt sleep, extracted to `abortAwareSleep` and
   injectable, so tests drive a simulated clock.

Non-retryable classes are untouched: upstream's `isRetryableKind` retries only
`refused_before_work` (a 429 or our own pre-send refusal); the tests pin `auth_invalid`,
`unrecoverable` and `quota_exhausted` failing on the first attempt.

**Upstream providers** — each wraps its `withRetry` callback in `pacedAttempt(...)` and spreads
`pacedRetryOptions(pacing)` *before* upstream's `...(signal ? { maxRetries: 0 } : {})` and
`...retryPolicyForPool(poolSize)`, so a field-compression call (which passes a signal) still
never retries and a pool still rotates. The policy is read from settings per request.
`OpenAICompatProvider` exposes `protected pacer` and `protected retrySleepFn` instance fields
(same pattern as upstream's `streamIdleTimeoutMs`) so the guard test can drive both.

**Upstream `src/shared/SettingsDefaultsManager.ts`** — eight keys, four per provider, same
defaults. Per-provider names follow upstream's namespacing (`CLAUDE_MEM_GEMINI_*`,
`CLAUDE_MEM_OPENAI_COMPAT_*`), so an openai-compatible user never edits `OPENROUTER_*` keys.

| Setting (`CLAUDE_MEM_OPENROUTER_*` / `CLAUDE_MEM_OPENAI_COMPAT_*`) | Default | Why that number |
|---|---|---|
| `_RATE_LIMITING_ENABLED` | `true` | On unless explicitly disabled — same posture as `CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED`. `false` = upstream's policy, untouched. |
| `_MIN_REQUEST_INTERVAL_MS` | `1500` | ~40 calls/min across every session, roughly what a single generator sustains on its own — one session barely notices, N sessions cannot storm. |
| `_RATE_LIMIT_BACKOFF_MS` | `75000` | The measured recovery window. Anything shorter re-trips the ceiling and burns an attempt. |
| `_MAX_RETRIES` | `4` | ~5 minutes of patience before the session pauses on `rate_limit`. |

Not added to `SettingsRoutes.ts` or the viewer settings modal — these paths are configured in
`settings.json`.

## Deliberately out of scope

- **`KnowledgeAgent`'s corpus-query fetch** hits the same endpoint with no retry and no pacing.
  One interactive call per user question contributes nothing to a storm, and pacing it would
  make an interactive query sit behind a 75s deferral caused by background work.
- **Per-attempt deadline vs. pacer wait.** The pacer wait runs inside `withRetry`'s attempt,
  so a non-streamed request's per-attempt deadline (`CLAUDE_MEM_LLM_TIMEOUT_MS`, default 180s)
  also covers time queued behind a deferral. A 75s deferral plus a long queue of sessions
  could approach it; streamed requests own their deadline and are unaffected.
- **Server-beta `OpenRouterObservationProvider`** — separate runtime, not the fork default.

## Re-sync after an upstream merge

Re-apply, in order: the three `retry.ts` edits; the `pacedAttempt` wrapper + `pacedRetryOptions`
spread in both providers (and the two instance fields in `OpenAICompatProvider`); the eight keys
in `SettingsDefaultsManager.ts`. `call-pacer.ts` is fork-owned and merges cleanly.

Guard: `bun test tests/openrouter-rate-limit.test.ts`. It drives a simulated clock (no test
sleeps) and asserts: `withRetry` outlives a ~75s outage and the upstream-shaped policy does not;
`Retry-After` wins and is clamped; non-retryable classes fail on the first attempt; the pacer
shares one budget; and, through `OpenAICompatProvider.query` itself, a single session outlives
the window with default settings while three concurrent sessions share one budget and are each
refused at most once.

The upstream suite assumes upstream's retry policy (no pacing, no 75s window, no jitter). It
must run with the fork policy off — `CLAUDE_MEM_OPENROUTER_RATE_LIMITING_ENABLED=false` and
`CLAUDE_MEM_OPENAI_COMPAT_RATE_LIMITING_ENABLED=false` in `tests/preload.ts` (set only when
unset). The guard test pins `..._RATE_LIMITING_ENABLED=true` for itself, so the preload cannot
turn it into a no-op.
