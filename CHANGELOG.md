# Changelog

All notable changes are documented here. The format follows Keep a Changelog and the project uses semantic versioning.

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
