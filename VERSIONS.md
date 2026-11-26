# Versions

This page is the version area for **claude-model-router**. The [README](README.md) is the operating manual; this page records what each version changed, what problem it fixed, and the measurements behind the decision. Every release also gets an entry in [CHANGELOG.md](CHANGELOG.md).

| Version | Date | Status | Notes |
|---|---|---|---|
| **v3 — 1.3.0** | 2026-11-26 | **current** | Capability detection is media-based: text mentions of video no longer hard-lock Kimi, and non-streaming auxiliary calls keep the default provider. Kimi share of the measured session window drops from 52.4% to 25.5% of tokens. [Full report →](docs/versions/v2-to-v3.md) |
| v2 — 1.2.0 | 2026-11-25 | previous | Routing fixes: read-only commands are no longer counted as mutations; de-escalation can run mid-turn; audit fields in the route log. Also adds version/update visibility in the Claude Code status line. [Full report →](docs/versions/v1-to-v2.md) |
| v1 — 1.1.0 | 2026-11-25 | previous | Observability and bounded de-escalation. [Release commit](https://github.com/dragonxia-ctrl/claude-model-router/commit/88491f1) |

---

## v2 → v3 at a glance

Measured on the live session window 2026-11-25 13:02:29Z–16:40Z (772 requests, 69.5M tokens), replayed from `router.log` through both rule sets. Streaming decisions are unchanged; only auxiliary non-streaming calls and text-only "video" mentions move.

| | **v2 (1.2.0)** | **v3 (1.3.0)** |
|---|---|---|
| **What counts as video input** | Any task text matching `视频理解 / analyze video / .mp4 / .mov`, treated as a hard Kimi-only capability | Only an actual video media block (`type: video` or `media_type: video/*`) |
| **Complex visual reasoning** | Text match, hard lock — never de-escalates | Text match is ordinary evidence — a clean window can probe back to DeepSeek |
| **Non-streaming auxiliary calls** | Same text heuristics and semantic triage as interactive turns; two channels ran 100% Kimi (18.7M tokens) | Default provider, unless an explicit model or real video media says otherwise |
| **`route_decision` log fields** | provider, model, reason, source, stats, keys, de-escalation outcome | + `capabilityKinds`, `hardCapability`, `media {video, image}` |
| **Kimi share of the window — requests** | 61.3% (473/772) | **21.2%** (164/772) |
| **Kimi share of the window — tokens** | 52.4% (36.42M) | **25.5%** (17.75M) |
| **Interactive channels' Kimi tokens** | 17.02M | 17.02M (unchanged) |
| **Tests** | 76 | **80** (4 added) |

The last-answer investigation that started this release is documented in [the report](docs/versions/v2-to-v3.md): the visible answers were escalated *mid-turn* by the (unchanged) 20-mutation rule; the anomaly was the auxiliary channels, which a text pattern had hard-locked with no recovery path.

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
| **Tests** | 49 | **76** (27 added) |

Both versions share the same defaults and safety model: DeepSeek is the default; Kimi needs evidence, progress signals, or a confident semantic triage; video/visual capabilities never de-escalate; a failed probe returns to Kimi with exponential backoff.

---

## v3 — 1.3.0 (2026-11-26)

**Problem.** After v2, some answers were still served entirely by Kimi, and the session window showed Kimi taking 52.4% of tokens. Two causes had to be separated: the visible answers were escalated mid-turn by the intended 20-mutation rule, but two *non-streaming auxiliary* channels (median 5 output tokens, 305 requests) ran 100% on Kimi — 18.7M tokens with no way back.

**Why.** "Video input is Kimi-only" came from a regular expression over task text, not from any media in the request, and it was marked `hard`, which permanently blocks the DeepSeek recovery probe. Auxiliary calls carrying task-like text therefore locked onto Kimi for good; semantic triage was a second, independent door.

**Evidence.** Replaying the live window with the v3 rule moves Kimi from 61.3% to 21.2% of requests and from 52.4% to 25.5% of tokens; the interactive channels keep exactly their previous numbers. Full tables and figures: **[docs/versions/v2-to-v3.md](docs/versions/v2-to-v3.md)**; data in [`docs/versions/data/v2-v3.json`](docs/versions/data/v2-v3.json), regenerated by `node docs/versions/replay-v3.mjs`.

**Fix.** `mediaKinds()` in `src/classifier.mjs` detects real video blocks; the video text pattern is removed; complex visual text is evidence, not a hard lock; benchmark text heuristics and semantic triage apply only to streaming requests; `route_decision` logs `capabilityKinds`, `hardCapability`, and `media`.

---

## v2 — 1.2.0 (2026-11-25)

**Problem.** A long but ordinary task — submitting two Kaggle competitions and archiving the result — was served 82.5% by Kimi (86.5% of tokens) even though the semantic triage classified it as `ordinary_coding` on every call. The same rule also switched a purely read-only analysis session to Kimi.

**Why.** Two independent defects compounded:

1. The progress rule escalates at 20 cumulative "mutating" tool calls, but the classifier treated almost every Bash command as mutating. `echo "=== x ===" && cat file`, inline `python3 - <<'PY'` that only reads logs, and `kaggle competitions submissions` all incremented the counter. The task crossed the threshold on read-only work.
2. Once on Kimi, a task was only re-evaluated at a *new user message*. The task was one continuous turn with no new message, so the recovery probe was unreachable and Kimi stayed for the rest of the run.

**Evidence.** Replaying the real request stream through the old engine reproduces the logged decisions 63/63; the fixed engine moves Kimi from 82.5% to 42.9% of requests (86.5% → 49.2% of tokens). Command classification drops from 83 to 43 “mutating” calls on that task. Figures and full tables: **[docs/versions/v1-to-v2.md](docs/versions/v1-to-v2.md)**.

**Fix.** Read-only command detection in `src/progress.mjs`; mid-turn recovery checkpoints in `src/decision-engine.mjs`; audit fields in `src/handler.mjs`. Six regression tests added; one existing test updated because a clean window now probes before the next user message.

**Also added.** Version visibility: the router reports its running release and the latest published release on `GET /version`, caches the update check locally (startup, then at most every six hours, silent when offline), and `scripts/version-status.mjs` renders it in Claude Code's native status line — dimmed while up to date, amber when an upgrade exists. `claude-router version` shows the same state outside Claude Code. `claude-router update` pulls `main`, verifies the commit, runs the offline tests, deploys with a backup, restarts, and verifies the live router, rolling back on failure. Fourteen tests cover the update checker, the `/version` endpoint, and the status line output; seven cover the updater.

---

## v1 — 1.1.0 (2026-11-25)

First public release line: local Anthropic-compatible proxy for DeepSeek and Kimi, evidence-based escalation, bounded semantic triage, sticky provider selection, real usage telemetry, health endpoints, and a reversible installer. See the [changelog](CHANGELOG.md#110---2026-11-25) for the full list.

---

## How this page is maintained

- A release is recorded here **and** in `CHANGELOG.md`; the version number follows semver.
- Measurements are stored as data, not prose: [`docs/versions/data/v1-v2.json`](docs/versions/data/v1-v2.json) and [`docs/versions/data/v2-v3.json`](docs/versions/data/v2-v3.json) hold every number used in the reports, and [`docs/versions/render-figures.mjs`](docs/versions/render-figures.mjs) regenerates the figures from them (`node docs/versions/render-figures.mjs`). The v2→v3 numbers come from the live log via `node docs/versions/replay-v3.mjs`. If a number changes, the figure changes with it.
- Figures are static SVG so they render on GitHub without JavaScript.
