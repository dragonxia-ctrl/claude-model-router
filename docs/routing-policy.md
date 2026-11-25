# Routing Policy

## Principle

**Default to DeepSeek. Escalate to Kimi only for a defensible advantage.**

The router does not treat length, importance, keyword density, or tool-call volume alone as proof that a task needs a more expensive model. A difficult refactoring task can still be an ordinary DeepSeek task.

The policy was derived from public model comparisons consulted in November 2026. Benchmarks are incomplete proxies, model aliases can change, and results are not independently reproduced by this repository. Treat the table as versioned policy rationale, not a permanent performance guarantee.

## Evidence-based routing

| Signal in task | Rationale | Result |
| --- | --- | --- |
| Video input/understanding | Kimi capability advantage | Kimi |
| Long-horizon autonomous project/application/system delivery | Terminal-Bench-style advantage | Kimi |
| Deep research, multi-step research, literature review, or source/evidence cross-verification | HLE-style research advantage | Kimi |
| Olympiad/frontier math, theorem proving, formal proofs | FrontierMath-style advantage | Kimi |
| Complex visual, chart, or diagram reasoning | ZeroBench-style advantage | Kimi |
| Ordinary coding, architecture, refactoring, debugging | DeepSeek comparable or better in consulted coding comparisons | DeepSeek |
| Kaggle, data science, finance, legal, general questions | No clear Kimi advantage established by the policy | DeepSeek |

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

Read-only exploration does not increment the mutating-call threshold. A failed test only counts as failed verification after at least one successful mutation, reducing escalation for a suite that was already red before any edits.

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
Kimi -- minimum residency + clean window + new human checkpoint --> DeepSeek probe
DeepSeek probe -- required successful requests --> recovered DeepSeek
DeepSeek probe -- upstream failure or new tool failures --> Kimi + exponential backoff
Recovered DeepSeek -- new failures/hard capability --> Kimi
```

A checkpoint is a new human text message. Tool-result-only `user` messages do not create checkpoints, so the default policy does not switch providers in the middle of an autonomous tool-use turn. Preview and token-count requests never advance routing state.

### Probe entry requirements

All applicable conditions must hold:

- de-escalation is enabled, DeepSeek is configured, and the selection is not an explicit override;
- the task has no hard Kimi-only capability requirement (currently video or complex visual reasoning);
- the configured number of actual Kimi requests has completed;
- failed-probe attempts remain below `maxAttempts`;
- the latest human message is a new checkpoint;
- the recent recovery window is clean.

A clean window has no failed verification, repeated normalized error group, trailing tool failure, or excessive repeated mutation; its failure rate is within budget. If recent edits have verification attempts, at least one must succeed. When tools are present, `minRecentToolCalls` requires enough recent evidence; a conversation with no tool calls can still recover after the request-based residency requirement.

Cumulative failure statistics still justify the original escalation, but do **not** permanently block de-escalation. Only the recent window decides whether execution has recovered.

### Failure and backoff

A non-successful upstream probe response (except a client abort), a failed verification, repeated errors, trailing failures, or other new unhealthy evidence returns the task to Kimi. The next residency requirement is:

```text
min(maxBackoffRequests, minKimiRequests × 2^attempts)
```

This is multiplicative backoff with a hard cap. After `maxAttempts` failed probes, the task remains on Kimi; a new task or an explicit selection resets the state. State is in memory and disappears on router restart.

### Defaults

| Setting | Default | Meaning |
| --- | ---: | --- |
| `routing.deescalation.enabled` | `true` | Enable bounded Kimi residency |
| `minKimiRequests` | `4` | Actual main Kimi requests before the first probe |
| `probeRequests` | `2` | Successful DeepSeek requests required to recover |
| `maxAttempts` | `3` | Maximum failed probe attempts per task state |
| `maxBackoffRequests` | `32` | Cap on post-failure Kimi residency |
| `windowToolCalls` | `24` | Most recent tool uses inspected for recovery |
| `minRecentToolCalls` | `4` | Minimum evidence when the recent window contains tools |
| `maxFailureRate` | `0.1` | Maximum recent failed-results/tool-calls ratio |
| `maxMutationRepeats` | `2` | Maximum repetitions of one mutation in a clean window |

Set `enabled: false` to restore permanent same-task Kimi stickiness. Explicit provider selection always wins for that request.

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
- `[kimi]`, `use kimi`, `使用 kimi`, and `强制 kimi` select Kimi;
- corresponding DeepSeek phrases select DeepSeek.

These aliases describe routing intent; the actual upstream model is still the configured provider model.

## Changing the policy

A policy change should include public evidence, expected false positives, expected cost impact, and tests for both matching and near-miss tasks. Update both READMEs and this document. See [CONTRIBUTING.md](../CONTRIBUTING.md).
