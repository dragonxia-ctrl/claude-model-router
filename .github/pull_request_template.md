## Summary

<!-- What changed and why? -->

## Verification

<!-- List exact commands and results. Unit tests alone are not integration proof. -->

- [ ] `npm test`
- [ ] Container tests (required for runtime/Docker changes)
- [ ] Manual platform/integration checks described below
- [ ] No real-provider tests were run, or their opt-in cost was understood

Platforms tested:

## Safety checklist

- [ ] No secrets, personal paths, private prompts, or account data included
- [ ] Dry-run remains the default for destructive operations
- [ ] Settings changes are limited to managed keys
- [ ] Backup/rollback/uninstall tests added for installer changes
- [ ] Routing changes include evidence and near-miss regressions
- [ ] English and Chinese documentation updated where needed
- [ ] No provider other than DeepSeek/Kimi added without prior architecture approval

## Notes for reviewers

<!-- Risks, rollback plan, unverified platforms, follow-up work. -->
