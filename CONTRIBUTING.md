# Contributing to Claude Model Router

Thank you for helping improve the router. This project changes global Claude Code settings and forwards private prompts to paid providers, so correctness and reversibility matter more than adding features quickly.

## Ground rules

1. **Never commit secrets.** No API keys, local tokens, real `config.json`, logs containing credentials, personal home paths, or provider account data.
2. **Preserve unrelated settings.** Installer changes must be limited to documented managed keys.
3. **Dry-run stays the default.** Any new destructive operation needs an explicit `--apply` or equivalent confirmation.
4. **Every write needs a rollback story.** Add or update tests for backup, failure recovery, and uninstall behavior.
5. **Tests are not integration proof.** A green unit suite does not prove Docker, Claude Code, or real-provider compatibility. State exactly what was verified.
6. **Do not equate task length, keywords, or tool counts with difficulty.** Routing changes need an evidence-based rationale and false-positive regressions.
7. **Only DeepSeek and Kimi are supported.** Do not add another provider in a routine PR. Open an architecture discussion first.

## Development setup

Requirements: Node.js 20+, Git, and Docker with Compose v2 for container work.

```bash
git clone https://github.com/dragonxia-ctrl/claude-model-router.git
cd claude-model-router
npm test
node bin/claude-router.mjs help
```

There are no runtime npm dependencies. Use Node built-ins unless a dependency is clearly justified.

## Test before submitting

At minimum:

```bash
npm test
node bin/claude-router.mjs install --runtime none \
  --data-dir "$(mktemp -d)/router" \
  --settings "$(mktemp -d)/settings.json"
```

The second command must be a dry run and must not create files.

For container changes:

```bash
docker build -t claude-model-router:test .
docker run --rm --network none --tmpfs /tmp \
  -v "$PWD:/work:ro" -w /work \
  claude-model-router:test node --test test/run.mjs
```

Real-provider tests are opt-in and cost money:

```bash
npm run verify
npm run verify:live -- --yes
```

Never put real credentials in CI, source files, fixtures, screenshots, or issue reports. Maintainers should not ask contributors to run paid tests without explaining the cost.

## Cross-platform requirements

Code must work on macOS, Linux, and Windows:

- use `node:path`, `node:os`, and `fileURLToPath` instead of string-built paths;
- use `spawn`/`execFile` argument arrays rather than shell interpolation;
- do not assume `/tmp`, `$HOME`, POSIX permissions, `sed`, `awk`, `zsh`, or `launchctl`;
- guard SIGHUP-only behavior on Windows;
- test paths containing spaces;
- keep Docker as the recommended production runtime.

The CI matrix covers Node 20/22/24 on Ubuntu, macOS, and Windows. If you cannot test a platform locally, say so in the PR; CI is not a substitute for describing manual verification.

## Changing routing policy

A routing PR should include:

1. the workload being changed;
2. public, reproducible benchmark or trace evidence;
3. why DeepSeek is insufficient or Kimi has a clear advantage;
4. positive and negative test cases, including near-miss phrases;
5. expected cost and latency effects;
6. documentation updates in both READMEs when user-visible behavior changes.

Be especially careful with broad phrases such as “end-to-end”, “cross-validation”, “complete system”, or “many tools”. Kaggle model cross-validation and end-to-end ML training must remain DeepSeek by default.

## Changing installer or settings behavior

Required tests:

- existing unrelated settings survive;
- dry-run writes nothing;
- backups exist before mutation;
- startup failure restores the original settings;
- uninstall restores only managed values;
- post-install user edits trigger a refusal unless forced;
- missing settings files are handled safely;
- keys and local tokens are never printed.

Test with temporary directories, never your real `~/.claude/settings.json`.

## Pull request checklist

- [ ] The change is scoped and explained.
- [ ] `npm test` passes.
- [ ] Container tests pass for Docker/runtime changes.
- [ ] Installer changes include rollback/uninstall tests.
- [ ] Routing changes include positive and negative regressions.
- [ ] English and Chinese READMEs are updated when needed.
- [ ] No secrets or personal information are included.
- [ ] The PR states exactly which platforms and integration paths were tested.
- [ ] Paid/live tests were not run without explicit intent.

## Versioning

Releases use `MAJOR.MINOR.PATCH` in `package.json` and `src/version.mjs`; the two values must always match.

- A small change — a bug fix, a wording change, or a self-contained improvement — increments only the third number (for example 1.6.1).
- The maintainer decides when the first two numbers change; a pull request must not choose them.
- Every functional change gets a short entry in `CHANGELOG.md` saying what changed.
- The measurement log in `VERSIONS.md` and `docs/versions/` is updated only when the maintainer asks for a recorded experiment; otherwise it stays as the historical record.

## Reporting security issues

Do not open a public issue for a vulnerability or exposed credential. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT License.
