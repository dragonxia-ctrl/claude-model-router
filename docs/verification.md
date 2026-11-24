# Verification Record

Date: 2026-11-24

This record distinguishes completed checks from unverified platforms. It is not a substitute for repeating verification on your own machine.

## Completed on the packaging machine

Environment: macOS, Node.js 24, Docker Desktop with Compose v2.

### Offline tests

- Host: **33/33 passed**.
- Container with `--network none`, read-only repository mount, and tmpfs `/tmp`: **33/33 passed**.
- No provider credentials or network access were used.

### Isolated Docker build and Compose smoke test

Used a temporary config, dummy provider keys, a random free port, a separate Compose project, and a separate image tag.

Passed:

- image build;
- `/health`;
- preview routed an ordinary short task to DeepSeek;
- preview routed a long-horizon autonomous project to Kimi;
- no selected upstream was contacted by preview;
- read-only root filesystem;
- `cap_drop: ALL`;
- read-only `/data` mount;
- loopback-only host port binding.

The first smoke-script attempt failed because the test script did not export its chosen port while generating config. It was not counted as a pass. The corrected test passed.

### Full isolated CLI lifecycle

Used temporary `settings.json` and data directory, dummy provider keys, and a separate Compose project.

Passed:

1. `install --apply` built and started a healthy router.
2. Only managed Claude settings changed; unrelated settings survived.
3. Legacy auth bypass settings were removed as documented.
4. `doctor` passed all checks.
5. `uninstall --apply` stopped the isolated container.
6. Original settings were restored and the install manifest was removed.

### Additional offline safety tests

- Dry-run writes nothing.
- Docker preflight failure happens before mutation.
- Simulated startup failure restores pre-existing files.
- Failed first startup removes newly created settings/config/helper/manifest.
- Failed upgrade restores the prior config/helper/settings/manifest.
- Post-install settings edits require forced uninstall.
- Forced uninstall preserves unrelated edits.
- Token-helper-only command does not touch Claude settings.

## Real-provider lineage

The router implementation was previously exercised with real DeepSeek and Kimi requests during development, including streaming, tool calls/results, semantic triage, and provider switching. Those production-lineage results are not presented as a fresh real-provider test of this packaged repository.

The public repository includes `npm run verify` and `npm run verify:live -- --yes` so users can repeat real-provider verification with their own keys. These commands are opt-in and cost tokens. No real keys were used for the isolated packaging checks above.

## Not yet manually verified here

- Windows Docker Desktop/WSL2 end-to-end installation.
- Linux Docker Engine end-to-end installation.
- Intel macOS and arm64 Linux container builds.
- Every Claude Code desktop/IDE version.

The CI workflow is intended to cover offline tests on Ubuntu, macOS, and Windows with Node 20/22/24, plus a Linux container build. Check the repository's current Actions results rather than assuming a historical local pass covers those environments.
