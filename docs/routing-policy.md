# Routing Policy

## Principle

**Default to DeepSeek. Escalate to Kimi only for a defensible advantage.**

The router does not treat length, importance, keyword density, or tool-call volume alone as proof that a task needs a more expensive model. A difficult refactoring task can still be an ordinary DeepSeek task.

The policy was derived from public model comparisons consulted in November 2026. Benchmarks are incomplete proxies, model aliases can change, and results are not independently reproduced by this repository. Treat the table as versioned policy rationale, not a permanent performance guarantee.

## Evidence-based routing

| Signal in task | Rationale | Result |
| --- | --- | --- |
| Video media block (`type: video` or `source.media_type: video/*`) | Only Kimi can consume video | Kimi (hard, never de-escalates) |
| Long-horizon autonomous project/application/system delivery | Terminal-Bench-style advantage | Kimi |
| Deep research, multi-step research, literature review, or source/evidence cross-verification | HLE-style research advantage | Kimi |
| Olympiad/frontier math, theorem proving, formal proofs | FrontierMath-style advantage | Kimi |
| Complex visual, chart, or diagram reasoning | ZeroBench-style advantage | Kimi (ordinary evidence; a clean window can probe back) |
| Ordinary coding, architecture, refactoring, debugging | DeepSeek comparable or better in consulted coding comparisons | DeepSeek |
| Kaggle, data science, finance, legal, general questions | No clear Kimi advantage established by the policy | DeepSeek |

Text heuristics and semantic triage apply only to **interactive streaming requests** (`stream: true`). Requests that omit `stream` or set it to `false` are auxiliary calls (classifiers, summaries) whose text can contain the same words without being that kind of task; they keep the default provider. Only real video media and explicit model selection can route them elsewhere. A text mention of video (`.mp4`, "video understanding") is not a capability requirement, and an image block alone never hard-locks.

### Deliberate near-miss handling

These must not trigger Kimi by themselves:

- Kaggle **cross-validation** (`交叉验证`)—this is model evaluation, not source cross-verification;
- **end-to-end model training**—this is a normal ML workflow, not an autonomous end-to-end project;
- a “complete analysis”, “multi-stage pipeline”, or environment setup;
- a long prompt or important business decision;
- many read-only searches or file reads.

Research escalation requires source/evidence language around cross-validation, or a stronger research phrase such as literature review/deep research.

## Progress-based escalation

Deterministic rules also inspect tool history after the selected task. Default thresholds:

| Signal | Default threshold |
| --- | --- |
| Failed verification cycles after successful edits | 2 |
| Distinct normalized error signatures occurring at least twice | 2 |
| Consecutive failed tool results | 3 |
| Mutating tool calls | 20 |
| Same mutating invocation repeated | 3 |

Read-only exploration does not increment the mutating-call threshold. Since v1.2.0 this also covers `echo`/`printf` chains, read-only CLI queries (`kaggle … status|list|files|leaderboard|submissions`, `pip list|show`), and inline Python whose source contains no write operation; script files and any write marker still count as mutations. A failed test only counts as failed verification after at least one successful mutation, reducing escalation for a suite that was already red before any edits.

Thresholds can be overridden under `routing.limits` using the keys in `src/progress.mjs`. Changes require regression tests.

## Semantic triage

For otherwise unclassified tasks at least `triageMinChars` long, optional DeepSeek semantic triage can recognize tasks that deterministic phrases miss.

- It is skipped when an evidence/progress rule already selected Kimi.
- It is skipped for explicit provider selection.
- It is cached by task hash.
- Kimi requires confidence at least `triageConfidence` (default `0.8`).
- Errors, timeouts, malformed output, or low confidence leave the request on DeepSeek.
- Thinking is disabled and output is capped to keep cost/latency bounded.

Semantic output is a hint, not an instruction channel. Task text is explicitly marked untrusted in the classifier system prompt.

## Bounded Kimi residency and de-escalation

Kimi is sticky **within a tool-use loop**, but not for the lifetime of a task. Permanent stickiness avoids oscillation at the cost of unnecessary expensive tokens on long tasks. The router therefore uses a bounded state machine:

```text
DeepSeek -- evidence of Kimi advantage --> Kimi
Kimi -- minimum residency + clean window + recovery checkpoint --> DeepSeek probe
DeepSeek probe -- required successful requests + clean window --> recovered DeepSeek
DeepSeek probe -- serious failure, or confirmed soft failure --> Kimi + backoff
DeepSeek probe -- transient upstream failure --> Kimi without consuming a quality attempt
Recovered DeepSeek -- serious failure, or confirmed soft failure --> Kimi + backoff
```

Kimi state is kept per `(conversationKey, taskKey)`, not per conversation. Several tasks can interleave in one terminal session; sharing one state let a second task overwrite the first task's residence and probe flags, producing phantom Kimi → DeepSeek → Kimi pulses.

A checkpoint is a new human text message or a **mid-turn review**: while a task is on Kimi, the same recovery window is evaluated on three independent clocks — after `windowToolCalls` (12) new tool calls, after `windowRequests` (6) Kimi requests, or after `windowMs` (300 000 ms) have elapsed since the last review — provided the request-based residency has been served. Tool-result-only `user` messages still do not create checkpoints by themselves; the mid-turn reviews are what let a single long turn leave Kimi once its execution has recovered. A blocked review resets every clock, so the next opportunity is one interval later. Preview and token-count requests never advance routing state.

When the optional latency clock is enabled (see below), a fourth checkpoint kind, `latency_window`, can open under provider-speed pressure. It is off by default.

The clocks are independent on purpose: a turn that makes few tool calls (mostly reading model output, or waiting on long-running commands) used to have no exit at all, because the only mid-turn clock counted tool calls. Measured on this installation's log, 33 of 38 sticky runs never reached 24 *new* tool calls, and the longest stayed on Kimi for 51 requests and 27.7 minutes; 63 of the 68 checkpoint opportunities under the new rules come from the request clock (see [v4 → v5](versions/v4-to-v5.md)).

An operator can also schedule a review out of band with `POST /v1/router/deescalate` or `claude-router deescalate`; the next main request still has to pass the ordinary residency, clean-window, and hard-capability gates.

### Probe entry requirements

All applicable conditions must hold:

- de-escalation is enabled, DeepSeek is configured, and the selection is not an explicit override;
- the task has no hard Kimi-only capability requirement (currently an actual video media block);
- the configured number of actual Kimi requests has completed;
- failed-probe attempts remain below `maxAttempts`, or `retryAfterExhaustedRequests` Kimi requests have elapsed since the last failed probe;
- a checkpoint occurred: a new human message, `windowToolCalls` new tool calls, `windowRequests` Kimi requests, `windowMs` elapsed since the last review, or (when enabled) `latency_window`;
- the recent recovery window is clean.

A clean window has no failed verification, repeated normalized error group, trailing tool failure, or excessive repeated mutation; its failure rate is within budget. The rate needs at least `minFailureDenominator` calls in the denominator and at least two actual failures, so one failure in a one- or two-call window cannot block recovery. If recent edits have verification attempts, at least one must succeed. When tools are present, `minRecentToolCalls` requires enough recent evidence; a conversation with no tool calls can still recover after the request-based residency requirement.

Cumulative failure statistics still justify the original escalation, but do **not** permanently block de-escalation. Only the recent window decides whether execution has recovered.

### Failure and backoff

Probe failures are classified before they affect state:

- **availability** — HTTP 408/425/429/5xx, connection/timeout, or stream failure. A transient outage says nothing about DeepSeek's task quality, so it does **not** consume a `maxAttempts` slot. The first two only require normal residency; from the third consecutive availability failure, the residency follows `minKimiRequests × 2^(n−2)` up to `maxBackoffRequests`. Any success resets the counter.
- **invalid request** — other 4xx responses, typically the old malformed-probe 400. This is not availability and not task quality, but it consumes one bounded retry attempt so a persistent configuration bug stops probing instead of retrying forever.
- **execution evidence** — a failed verification or a repeated error group relapses immediately. Trailing failures, failure-rate breaches, repeated mutations, and edits without a successful verification are *soft*: they must be seen on `relapseConfirmations` consecutive reviews (default 2) before the task returns to Kimi. A `relapse_pending` review keeps the task on DeepSeek and records the streak. A failed probe or a newly started probe cycle resets that streak, so one cycle's pending evidence cannot relapse the next cycle early.

A client abort does not change the probe state.

An invalid-request probe failure or a confirmed execution relapse returns the task to Kimi with:

```text
min(maxBackoffRequests, minKimiRequests × 2^attempts)
```

This is multiplicative backoff with a hard cap. An invalid-request probe failure and a confirmed relapse both advance `attempts`; the old behaviour reset it to zero on relapse and could produce a 4-request cycle indefinitely. Availability failures use their separate counter instead (see above). After `maxAttempts` failed probes the normal backoff cycle ends, but Kimi is not locked permanently: once `retryAfterExhaustedRequests` (16) Kimi requests have passed, the next clean checkpoint may start a new probe cycle. Set `retryAfterExhaustedRequests: 0` to restore the previous "stop probing after `maxAttempts`" behaviour. A new task or an explicit selection resets the state. State is in memory and disappears on router restart.

### Optional latency-aware review

Kimi's average time per output token is much higher than DeepSeek's. During a long Kimi session the router can therefore treat sustained Kimi slowness as one more recovery checkpoint, switch a mechanical phase to the faster provider, and let the ordinary clean-window evaluation decide whether to stay there.

The feature is **disabled by default** because a provider switch discards the other provider's prompt cache and can reduce answer quality on design-heavy work. It is configured under `routing.deescalation.latencyCheckpoint`:

- `enabled` (default `false`) — opt in.
- `enterRatio` / `exitRatio` (default `0.6` / `0.8`) — Kimi is slow when its tokens/second is below `enterRatio ×` the DeepSeek baseline; pressure clears only above `exitRatio ×`. The gap is hysteresis.
- `samples` (default `3`) — consecutive Kimi samples below the entry ratio before pressure is asserted.
- `minBaselineSamples` (default `3`) — samples needed from both providers before a ratio is trusted.
- `fastWindowMs` (default `90000`) — minimum time since the previous checkpoint, so speed alone cannot churn the route on every request.
- `cooldownRequests` (default `8`) — Kimi requests skipped after a failed probe or relapse before a latency checkpoint can open again.
- `minReadOnlyShare` (default `0.5`) — at least this share of the recent tool window must be reads or test runs. A turn with no tool calls never qualifies: without tool evidence the router cannot tell a mechanical phase from design work.
- `minOutputTokens` (default `20`) — responses below this are too short for a meaningful tokens/second sample.
- `emaAlpha` (default `0.2`) — smoothing factor for the per-provider speed and TTFB baselines.

Speed is measured as `output_tokens ÷ (durationMs − ttfbMs)` and smoothed per provider (the tracker is shared across conversations). The checkpoint still requires residency, a clean window, and all the ordinary gates. After a successful probe the task stays on DeepSeek; only serious or confirmed execution failures, a hard capability, or an operator request bring it back to Kimi. The router also records `switchPrefillPenaltyMs`, the extra time to first byte on a provider switch compared with that provider's own baseline.

### Defaults

| Setting | Default | Meaning |
| --- | ---: | --- |
| `routing.deescalation.enabled` | `true` | Enable bounded Kimi residency |
| `minKimiRequests` | `4` | Actual main Kimi requests before the first probe |
| `probeRequests` | `2` | Successful DeepSeek requests required to recover |
| `maxAttempts` | `3` | Failed probes before the normal backoff cycle ends |
| `maxBackoffRequests` | `16` | Cap on post-failure Kimi residency |
| `windowToolCalls` | `12` | Size of the inspected recovery window, and new tool calls between mid-turn reviews |
| `windowRequests` | `6` | Kimi requests between mid-turn recovery reviews |
| `windowMs` | `300000` | Elapsed time (ms) between mid-turn recovery reviews |
| `retryAfterExhaustedRequests` | `16` | Kimi requests after which an exhausted state may probe again (`0` disables) |
| `minRecentToolCalls` | `4` | Minimum evidence when the recent window contains tools |
| `maxFailureRate` | `0.1` | Maximum recent failed-results/tool-calls ratio |
| `minFailureDenominator` | `10` | Minimum denominator used for the recent failure rate; two failures are also required |
| `relapseConfirmations` | `2` | Consecutive reviews of soft failure evidence before returning to Kimi |
| `maxMutationRepeats` | `2` | Maximum repetitions of one mutation in a clean window |
| `latencyCheckpoint.enabled` | `false` | Optional speed-pressure recovery checkpoint (see above) |

Set `enabled: false` to restore permanent same-task Kimi stickiness. Explicit provider selection always wins for that request.

### Operator interface

Two authenticated loopback endpoints expose the in-memory state machine and provide a manual exit:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/router/state` | Residency and probe state per task: `conversationKey`, `taskKey`, provider, phase, `kimiRequests`/`requiredKimiRequests`, attempts, probe successes, `relapseStreak`, availability failures, last probe failure, latency cooldown, checkpoint baselines, and whether a manual checkpoint is pending |
| `POST /v1/router/deescalate` | `{"conversationKey":"…"}` or `{"all":true}` — schedule a recovery checkpoint for every active task of that conversation (or all conversations); the response lists unique conversation keys |

```bash
claude-router state
claude-router state --json
claude-router deescalate --conversation <conversationKey>
claude-router deescalate --all
```

A manual request is not a forced switch: it sets the checkpoint flag and clears the failed-attempt cycle, and the next main request still has to pass the clean-window and hard-capability gates. The state list carries no task text or message bodies. State is in memory, so both commands return an empty/404 result after a router restart until the conversation routes again.

### Open-source design references

The policy combines established reliability and routing patterns; it does not copy any one project or add runtime dependencies:

- [Envoy outlier detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier): eject, then cautiously reintroduce;
- [Kubernetes Horizontal Pod Autoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/): a stabilization window for scale-down decisions;
- [Resilience4j](https://github.com/resilience4j/resilience4j) and [Polly](https://github.com/App-vNext/Polly): half-open circuit breakers with limited trials;
- TCP congestion control ([RFC 5681](https://www.rfc-editor.org/rfc/rfc5681)): additive/multiplicative control ideas, applied here as fast escalation and capped exponential backoff;
- [LiteLLM](https://github.com/BerriAI/litellm): cooldown/fallback operational patterns;
- [RouteLLM](https://github.com/lm-sys/RouteLLM) and [FrugalGPT](https://github.com/stanford-futuredata/FrugalGPT): cost-aware cascades and reusing the cheaper tier when evidence permits.

Unlike an availability-only circuit breaker, this router also inspects task capabilities and execution evidence. A successful HTTP response alone cannot prove answer quality; recovery therefore requires both successful probes and a clean recent execution window.


## Explicit override

Highest precedence:

- model names beginning with `kimi`, `claude-opus`, or `claude-fable` select Kimi;
- model names beginning with `deepseek` or `claude-haiku` select DeepSeek;
- `[kimi]` or `[deepseek]` at the start of the prompt selects that provider.
  A prompt that starts with `[deepseek]` stays on DeepSeek even if it later
  discusses Kimi. A marker inside quoted material is not an instruction;
- a leading `force kimi` / `force deepseek` (or `强制 kimi` / `强制 deepseek`)
  does the same.

Ordinary mentions such as `use kimi` or `使用 kimi` are **not** instructions:
they occur in normal questions and in conversation text copied into background
requests, and treating them as commands forced Kimi onto DeepSeek work.

These aliases describe routing intent; the actual upstream model is still the configured provider model.

## Changing the policy

A policy change should include public evidence, expected false positives, expected cost impact, and tests for both matching and near-miss tasks. Update both READMEs and this document. See [CONTRIBUTING.md](../CONTRIBUTING.md).
