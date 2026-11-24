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

## Sticky provider

Once Kimi is chosen, subsequent requests for the same task remain on Kimi unless the user explicitly selects another provider. This reduces model oscillation within a tool-use loop. A new task in the same conversation is evaluated independently.

## Explicit override

Highest precedence:

- model names beginning with `kimi`, `claude-opus`, or `claude-fable` select Kimi;
- model names beginning with `deepseek` or `claude-haiku` select DeepSeek;
- `[kimi]`, `use kimi`, `使用 kimi`, and `强制 kimi` select Kimi;
- corresponding DeepSeek phrases select DeepSeek.

These aliases describe routing intent; the actual upstream model is still the configured provider model.

## Changing the policy

A policy change should include public evidence, expected false positives, expected cost impact, and tests for both matching and near-miss tasks. Update both READMEs and this document. See [CONTRIBUTING.md](../CONTRIBUTING.md).
