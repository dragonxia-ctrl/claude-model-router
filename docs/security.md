# Security and Threat Model

## Assets

- DeepSeek and Kimi API keys.
- The local router bearer token.
- Claude Code `settings.json` and unrelated user preferences.
- Prompts, source code, tool output, and model responses.
- Provider spend and routing integrity.

## Trust boundaries

1. **Claude Code → local router:** HTTP on host loopback with a bearer token.
2. **Installer → host filesystem:** explicit, dry-run-by-default settings mutation with backups.
3. **Router container → host:** only a read-only bind mount of the router data directory and a loopback published port.
4. **Router → providers:** outbound HTTPS with provider credentials.
5. **Semantic classifier:** receives truncated task text through DeepSeek.

## Container hardening

`compose.yaml` applies:

- read-only root filesystem;
- tmpfs `/tmp`;
- all Linux capabilities dropped;
- `no-new-privileges`;
- init process for signal handling;
- read-only config mount;
- `127.0.0.1` host port binding only.

The current image runs as root inside the container so it can read a host config mounted as mode `0600`. The container is unprivileged on the host and has no writable host mount. A future non-root image must solve config ownership without encouraging world-readable secrets.

Docker Desktop/Engine is itself privileged. Container hardening reduces impact; it does not make an untrusted Docker daemon safe.

## Installer protections

- Install and uninstall are dry-run unless `--apply` is present.
- POSIX root execution is refused unless explicitly overridden.
- Docker and Compose are checked before host settings are changed.
- Provider keys are validated before mutation.
- Existing config/settings/manifest are backed up with timestamps.
- Only documented settings keys are managed.
- JSON is written through a temporary file and rename.
- Startup or health failure restores the pre-install state and stops the partial container deployment.
- Uninstall detects post-install edits and requires `--force` before touching them.
- Forced uninstall restores only managed values and preserves unrelated edits.

Backups can contain API keys and old settings. Keep the entire data directory private and never commit it.

## Network exposure

Do not change the published port to `0.0.0.0` or deploy this service directly to the public internet. The local token is not a complete multi-user security design, and the service has no TLS termination, rate limiting, tenant isolation, or audit database.

If remote access is needed, design and review a separate authenticated gateway rather than weakening the loopback default.

## Logging and privacy

Router logs contain request IDs, selected provider/model, routing reason/source, streaming flag, and aggregate tool statistics. They do not intentionally contain prompts, file contents, provider keys, or local tokens. Error messages from dependencies should still be reviewed before sharing logs.

Prompts leave the machine. Ordinary traffic goes to the selected provider; semantic triage additionally sends truncated current task text to DeepSeek. Local routing is not local inference.

## Credential rotation

1. Rotate exposed keys in the DeepSeek/Moonshot consoles.
2. Run `node bin/claude-router.mjs configure` to update local keys.
3. If the local token may be exposed, generate a fresh 64-character hex token, replace `router.token` in the active config, restart the router, and restart Claude Code. The generated helper reads the current config, so it does not contain a separate embedded token.
4. Restart the router and all Claude Code surfaces.
5. Review provider billing and local logs.

Never rotate credentials by posting the old or new value in an issue.

## Reporting

Use private GitHub vulnerability reporting. See [SECURITY.md](../SECURITY.md).
