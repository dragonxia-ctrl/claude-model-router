# Versions

This page is the version area for **claude-model-router**. The [README](README.md) is the operating manual; this page records what each version changed, what problem it fixed, and the measurements behind the decision. Every release also gets an entry in [CHANGELOG.md](CHANGELOG.md).

| Version | Date | Status | Notes |
|---|---|---|---|
| **v2 — 1.2.0** | 2026-11-25 | **current** | Routing fixes: read-only commands are no longer counted as mutations; de-escalation can run mid-turn; audit fields in the route log. Also adds version/update visibility in the Claude Code status line. [Full report →](docs/versions/v1-to-v2.md) |
| v1 — 1.1.0 | 2026-11-25 | previous | Observability and bounded de-escalation. [Release commit](https://github.com/dragonxia-ctrl/claude-model-router/commit/88491f1) |

---

## v1 → v2 at a glance

The single table to read if you only read one thing. "Kimi share" is measured on the same real 63-request task, replayed through both engines (see [the report](docs/versions/v1-to-v2.md#4-evidence)).

| | **v1 (1.1.0)** | **v2 (1.2.0)** |
|---|---|---|
| **What counts as a "mutating" command** | Anything outside a short read-only allowlist: `echo … && cat`, inline `python3` analysis, `kaggle … status/list` all counted | Real writes only; read-only chains, read-only CLIs, and write-free inline Python are excluded (`src/progress.mjs`) |
| **When Kimi is re-evaluated** | Only on a new user message — a single long turn stayed on Kimi until it ended | Also every 24 new tool calls, using the same recovery window, backoff, and probe rules (`src/decision-engine.mjs`) |
| **`route_decision` log fields** | provider, model, reason, source, stats | + `conversationKey`, `taskKey`, `deescalationOutcome` (`src/handler.mjs`) |
| **Kimi share of the measured task — requests** | 82.5% (52/63) | **42.9%** (27/63) |
| **Kimi share of the measured task — tokens** | 86.5% | **49.2%** |
| **Kimi share with `routing.limits.mutatingCalls: 40`** | — | **3.2%** of requests / 3.9% of tokens |
| **First escalation in that task** | 10:47 (21 “mutating” calls, mostly reads) | 11:16 (20 real writes) |
| **Version visibility in Claude Code** | None; `/health` exposed only an internal schema number | Native status line `router v1.2.0 · latest v…` (amber when an update exists), `GET /version`, `claude-router version` (`src/version.mjs`, `scripts/version-status.mjs`) |
| **Tests** | 49 | **68** (19 added) |

Both versions share the same defaults and safety model: DeepSeek is the default; Kimi needs evidence, progress signals, or a confident semantic triage; video/visual capabilities never de-escalate; a failed probe returns to Kimi with exponential backoff.

---

## v2 — 1.2.0 (2026-11-25)

**Problem.** A long but ordinary task — submitting two Kaggle competitions and archiving the result — was served 82.5% by Kimi (86.5% of tokens) even though the semantic triage classified it as `ordinary_coding` on every call. The same rule also switched a purely read-only analysis session to Kimi.

**Why.** Two independent defects compounded:

1. The progress rule escalates at 20 cumulative "mutating" tool calls, but the classifier treated almost every Bash command as mutating. `echo "=== x ===" && cat file`, inline `python3 - <<'PY'` that only reads logs, and `kaggle competitions submissions` all incremented the counter. The task crossed the threshold on read-only work.
2. Once on Kimi, a task was only re-evaluated at a *new user message*. The task was one continuous turn with no new message, so the recovery probe was unreachable and Kimi stayed for the rest of the run.

**Evidence.** Replaying the real request stream through the old engine reproduces the logged decisions 63/63; the fixed engine moves Kimi from 82.5% to 42.9% of requests (86.5% → 49.2% of tokens). Command classification drops from 83 to 43 “mutating” calls on that task. Figures and full tables: **[docs/versions/v1-to-v2.md](docs/versions/v1-to-v2.md)**.

**Fix.** Read-only command detection in `src/progress.mjs`; mid-turn recovery checkpoints in `src/decision-engine.mjs`; audit fields in `src/handler.mjs`. Six regression tests added; one existing test updated because a clean window now probes before the next user message.

**Also added.** Version visibility: the router reports its running release and the latest published release on `GET /version`, caches the update check locally (startup, then at most every six hours, silent when offline), and `scripts/version-status.mjs` renders it in Claude Code's native status line — dimmed while up to date, amber when an upgrade exists. `claude-router version` shows the same state outside Claude Code. Thirteen tests cover the update checker, the endpoint, and the status line output.

---

## v1 — 1.1.0 (2026-11-25)

First public release line: local Anthropic-compatible proxy for DeepSeek and Kimi, evidence-based escalation, bounded semantic triage, sticky provider selection, real usage telemetry, health endpoints, and a reversible installer. See the [changelog](CHANGELOG.md#110---2026-11-25) for the full list.

---

## How this page is maintained

- A release is recorded here **and** in `CHANGELOG.md`; the version number follows semver.
- Measurements are stored as data, not prose: [`docs/versions/data/v1-v2.json`](docs/versions/data/v1-v2.json) holds every number used in the report, and [`docs/versions/render-figures.mjs`](docs/versions/render-figures.mjs) regenerates the figures from it (`node docs/versions/render-figures.mjs`). If a number changes, the figure changes with it.
- Figures are static SVG so they render on GitHub without JavaScript.
