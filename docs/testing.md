# Testing and Verification

A green unit test is not proof that Claude Code integration works. Use the least expensive layer that verifies the claim, and report exactly which layers ran.

## Layer 1: offline unit/integration tests

```bash
npm test
```

No Docker, provider key, or network access is needed.

Suites:

| File | Coverage |
| --- | --- |
| `classifier.test.mjs` | Default policy, explicit overrides, evidence rules, false positives |
| `progress.test.mjs` | Tool classification, verification failures, repeated errors/mutations |
| `decision-engine.test.mjs` | Sticky history, semantic cache, confidence, fallback |
| `deescalation.test.mjs` | Checkpoints, clean recovery, probe success/failure, relapse, backoff, hard locks |
| `config-store.test.mjs` | Validation, reload, restart-required detection |
| `handler.test.mjs` | Auth, HTTP routes, preview, model rewrite, streaming, sticky/probe outcome integration |
| `telemetry.test.mjs` | Health endpoints, real usage, Prometheus, JSONL retention and pseudonymization |
| `install.test.mjs` | Settings merge, backup/manifest, rollback, uninstall |
| `cli.test.mjs` | Dry-run-by-default, token-helper isolation, and safety help |
| `doctor.test.mjs` | Healthy deployment checks and stale helper detection |

Use only dummy endpoints and credentials in tests. Never point an offline test at a real provider.

The terminal usage mod has a separate Claude Code harness:

```bash
claude plugin validate mods/usage-probe
claude plugin test mods/usage-probe
```

These tests verify footer component ordering and usage formatting, not every Claude Code desktop/IDE surface. Record interactive terminal verification separately.

## Layer 2: isolated container tests

```bash
docker build -t claude-model-router:test .
docker run --rm --network none --tmpfs /tmp \
  -v "$PWD:/work:ro" -w /work \
  claude-model-router:test node --test test/run.mjs
```

`--network none` proves the suite cannot accidentally spend tokens. The repository mount is read-only and `/tmp` is writable for temporary fixtures.

For Compose changes, use a temporary data directory, dummy keys, a non-default port, and an isolated Compose project. Do not run tests against a production config or live router port.

## Layer 3: deployment smoke test

```bash
npm run doctor
npm run verify
```

`verify` checks health and provider readiness, then makes one small real DeepSeek auto request and validates the returned model. It costs tokens.

## Layer 4: comprehensive live suite

```bash
npm run verify:live -- --yes
```

Requires explicit `--yes` or `CLAUDE_ROUTER_LIVE_TESTS=1`. The suite covers preview/routing, semantic triage, ordinary and streaming responses, both providers' tool calls/tool results, and both provider-switch directions. Unique run IDs avoid sticky-history contamination between runs.

Live tests are never part of installation or CI.

## CI matrix

- Node 20, 22, 24 on Ubuntu, macOS, Windows.
- Offline test suite and CLI help smoke test.
- Docker image build and tests with `--network none` on Ubuntu.
- Compose config validation.

A Windows unit-test pass does not prove Docker Desktop/WSL2 integration; a Linux container pass does not prove Claude Code desktop behavior. Record manual integration separately.

## Adding a regression

1. Write the smallest failing case first.
2. Use synthetic prompts and tool results.
3. Include near-miss cases for routing changes.
4. Keep assertions focused on behavior, not incidental wording.
5. Run offline tests, then container tests for runtime changes.
6. State whether any real-provider integration was run and its cost implications.

## Manual release checklist

- [ ] Offline matrix passes.
- [ ] Container tests pass with no network.
- [ ] Fresh temporary install rolls back on simulated startup failure.
- [ ] Compose smoke test uses an isolated project and dummy keys.
- [ ] Repository secret scan is clean.
- [ ] English and Chinese documentation match behavior.
- [ ] Optional real-provider verification was explicitly approved and passed.
- [ ] No live/production router was modified by staging tests.
