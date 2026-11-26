# Changelog

All notable changes are documented here. The format follows Keep a Changelog and the project uses semantic versioning.

The version area with the problem analysis and measured evidence lives in [VERSIONS.md](VERSIONS.md).

## [1.5.0] - 2026-11-26

### Changed

- Mid-turn recovery reviews no longer depend on tool-call count alone. While a task is on Kimi, the clean-window review now runs after `windowToolCalls` (12, was 24) new tool calls, `windowRequests` (6) Kimi requests, or `windowMs` (5 minutes), whichever comes first. Replayed against the live log, 28 of 38 sticky runs would have had at least one checkpoint opportunity instead of 5, with 68 opportunities instead of 6.
- `maxBackoffRequests` is capped at 16 (was 32), halving the longest post-failure Kimi residency a failed probe can require.
- Exhausting `maxAttempts` now ends the backoff cycle rather than permanently stopping recovery: after `retryAfterExhaustedRequests` (16) Kimi requests, a clean checkpoint may start a new probe cycle. Set it to `0` to keep the previous stop-after-attempts behaviour.
- The recovery window size and mid-turn review interval share `windowToolCalls`; with 12, the clean-window judgement uses the most recent 12 tool calls instead of the most recent 24.

### Added

- `GET /v1/router/state` and `POST /v1/router/deescalate` (local bearer token), with `claude-router state` and `claude-router deescalate --conversation <key> | --all`: inspect in-memory residency and schedule a recovery checkpoint. A manual request still has to pass the clean-window and hard-capability gates.
- `route_decision` logs carry `deescalationCheckpoint` (`user`, `tool_window`, `request_window`, `idle_window`, `manual`), `kimiRequests`, and `requiredKimiRequests`; probe requests write a `deescalation_probe_outcome` line with `outcome`, `httpStatus`, `errorKind`, `attempts`, and `requiredKimiRequests`.
- `docs/versions/v4-to-v5.md`, `docs/versions/data/v4-v5.json`, and `docs/versions/replay-v5.mjs`: the v4→v5 report, its replay data, and the script that regenerates it from `router.log`.

Unchanged: escalation evidence, the default provider, explicit model selection, hard video capability, probe length (2), clean-window thresholds, and the 4-request minimum residency. See [docs/versions/v4-to-v5.md](docs/versions/v4-to-v5.md).

## [1.4.0] - 2026-11-26

### Added

- **Automatic updates.** `updates.auto` (default off) and `claude-router update --auto on|off` let the running router install a newer published release by itself. The install runs as a detached updater — clean `main` checkout, version agreement, offline tests, backup, restart, health/`/version`/preview verification, rollback on failure — so the launchd restart cannot interrupt verification. Output goes to `auto-update.log`, state to `auto-update-state.json`, and a failure backs off for an hour. `claude-router update --auto` prints the switch, the last attempt, and its error.
- **"update installed, restart to update" in the status line.** When the deployed `version.mjs` is newer than the running process (a `--restart none` install, or the moment before a service restart), the status line shows it in amber instead of claiming the old version is current.
- The status line names the automatic-update state when an upgrade exists: `· auto-update on`, `· auto-update running`, or `· auto-update failed`.

### Fixed

- The latest release no longer lags a published GitHub version. The router checks at most every 30 minutes instead of every six hours, and when the cached check is older than ten minutes the status line starts a throttled, detached refresh; several Claude Code windows share one GitHub read.
- A restarted router now writes its release into the cache immediately, even when the cached release check is still fresh, so the status line never shows the previous process's version.
- A failed or offline release check keeps the last known latest release and records the attempt instead of forgetting the release or retrying on every render. Cache writes are atomic and merge fields owned by other writers.

## [1.3.0] - 2026-11-26

### Fixed

- "Video input is Kimi-only" no longer comes from a text pattern. A video media block (`type: video` or `source.media_type: video/*`) is now the only hard Kimi-only capability, so a task that merely mentions video, `.mp4`, or "video understanding" no longer locks onto Kimi.
- Complex visual reasoning text is ordinary evidence instead of a hard lock, so a clean recovery window can probe back to DeepSeek. An image block on its own never hard-locks.
- Non-streaming auxiliary calls (requests that omit `stream` or set it to `false`) keep the default provider: benchmark text heuristics and semantic triage now apply only to interactive streaming requests. Two measured auxiliary channels had run 100% on Kimi (18.7M tokens) because their text matched those heuristics and the hard lock blocked every recovery probe. Explicit model selection and real video media still win.

### Added

- `route_decision` logs now carry `capabilityKinds`, `hardCapability`, and `media: {video, image}`.
- `docs/versions/v2-to-v3.md`, `docs/versions/data/v2-v3.json`, and `docs/versions/replay-v3.mjs`: the v2→v3 report, its measurements, and the script that regenerates them from `router.log`. Two new figures cover Kimi share and per-channel token totals.
- Four regression tests for media-based capability detection and the interactive scope of text heuristics (80 tests total).

On the measured 2026-11-25 session window (772 requests, 69.5M tokens), Kimi's share moves from 61.3% to 21.2% of requests (52.4% → 25.5% of tokens); interactive channels are unchanged. See [docs/versions/v2-to-v3.md](docs/versions/v2-to-v3.md).

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
