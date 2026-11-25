# Changelog

All notable changes are documented here. The format follows Keep a Changelog and the project uses semantic versioning.

The version area with the problem analysis and measured evidence lives in [VERSIONS.md](VERSIONS.md).

## [1.2.0] - 2026-11-25

### Fixed

- Read-only command shapes no longer count toward the cumulative mutating-call escalation rule: `echo`/`printf` chains, read-only CLI queries (`kaggle … status|list|files|leaderboard|submissions`, `pip list|show`), and inline Python with no write operation. Real writes, script files, and any write marker still count.
- A task that escalated to Kimi can now recover inside a single long turn. The same 24-tool-call recovery window is evaluated every 24 new tool calls, in addition to new user messages; backoff, probe length, hard-capability locks, and relapse behavior are unchanged.

### Added

- `route_decision` logs now carry `conversationKey`, `taskKey`, and `deescalationOutcome`, so a routing decision can be attributed to a session and a de-escalation attempt.
- `GET /version` reports the running release, the latest published release, and update availability; `/health` also carries `release`. The router checks its own GitHub releases at startup and at most every six hours (falling back to the `package.json` version on `main` through the GitHub contents API, then tags), caches the answer, and stays silent when offline.
- `scripts/version-status.mjs` shows `router v<current> · latest v<published>` in Claude Code's native status line and highlights the line when an update is available; `claude-router version` prints the same state outside Claude Code. The status line helper reads only the local cache file.
- `claude-router update` (`scripts/router-update.mjs`) updates a service install from GitHub in one step: pull `main`, verify the commit and release, run the offline tests, deploy with a backup, restart, and verify health, `/version`, and a routing preview; roll back on failure.
- `VERSIONS.md` and `docs/versions/`: per-version reports with reproducible measurements and generated figures.
- Five regression tests for command classification and mid-turn recovery, plus one for the log fields.

### Changed

- One existing de-escalation test now probes mid-turn instead of waiting for the next user message.

On the measured 63-request task, Kimi's share moves from 82.5% to 42.9% of requests (86.5% → 49.2% of tokens). See [docs/versions/v1-to-v2.md](docs/versions/v1-to-v2.md).

## [1.1.0] - 2026-11-25

### Added

- Liveness, readiness, and authenticated passive deep-health endpoints.
- Real JSON/SSE token-usage capture, request metrics, Prometheus export, and optional pseudonymous JSONL persistence with retention and rotation.
- Terminal usage-probe mod that places per-model token/time ratios above the native turn-duration footer, plus `/router-usage` details.
- Bounded Kimi residency with clean-window DeepSeek probes, hard-capability locks, relapse detection, and capped exponential backoff.
- Regression and integration tests for health, telemetry, usage formatting, and de-escalation transitions.

### Changed

- Same-task Kimi stickiness is limited to tool-loop stability by default; it is no longer a permanent task-lifetime pin unless de-escalation is explicitly disabled.

## [1.0.0] - 2026-11-24

### Added

- Local Anthropic-compatible proxy for Claude Code.
- DeepSeek default routing and evidence-based Kimi escalation.
- Progress-aware escalation and bounded semantic triage with safe fallback.
- Sticky provider selection and cross-provider thinking-block sanitization.
- Streaming and non-streaming forwarding for Messages and token-count endpoints.
- Dry-run-by-default installer, managed settings merge, timestamped backups, automatic rollback, and manifest-based uninstall.
- Hardened Docker Compose deployment with loopback-only networking and read-only configuration.
- Cross-platform Node.js CLI, doctor, status, configuration, logs, and verification commands.
- Offline test suite, isolated container tests, and opt-in real-provider verification.
- English and Simplified Chinese documentation.

### Scope

- Supports DeepSeek and Kimi only.
