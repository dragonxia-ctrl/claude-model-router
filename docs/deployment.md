# Deployment Guide

The recommended deployment uses Docker for the long-running router and a host-side Node.js CLI for installation and diagnostics.

## Standard install

```bash
git clone https://github.com/dragonxia-ctrl/claude-model-router.git
cd claude-model-router
npm run setup                 # dry run
npm run setup -- --apply      # explicit mutation
npm run doctor
npm run verify                # one real request
```

Restart all Claude Code processes after installation.

## Paths

Defaults:

- router data: `~/.claude/model-router`;
- Claude settings: `~/.claude/settings.json`;
- Compose project: `claude-model-router`;
- host/container port: `17861`.

`CLAUDE_CONFIG_DIR` changes the default Claude settings directory. `CLAUDE_ROUTER_DATA_DIR` changes the default router data directory. CLI flags override both:

```bash
node bin/claude-router.mjs install \
  --data-dir /path/to/router-data \
  --settings /path/to/settings.json \
  --port 17862
```

Preview first by omitting `--apply`.

## Isolated staging

For testing a second checkout without touching a working deployment:

1. use a new empty temporary data directory;
2. use dummy provider keys and a non-default free port;
3. set a different Compose project name with `CLAUDE_ROUTER_PROJECT`;
4. set a different image tag with `CLAUDE_ROUTER_IMAGE` if needed;
5. never point `--settings` at the live settings file;
6. stop only the staging Compose project after validation.

The production defaults remain `claude-model-router` and `claude-model-router:local`.

## Manual Node runtime

Docker is recommended, but the router itself has no dependencies:

```bash
export CLAUDE_ROUTER_CONFIG="$HOME/.claude/model-router/config.json"
npm start
```

On Windows PowerShell:

```powershell
$env:CLAUDE_ROUTER_CONFIG = "$HOME\.claude\model-router\config.json"
npm start
```

You must manage process lifecycle, restart-on-boot, logs, and hardening yourself. `--runtime none --apply` patches config/settings without starting Docker.

## Platform notes

### macOS

- Docker Desktop must be running before `--apply`.
- Node from the official installer, Homebrew, or a version manager works; if its absolute path changes, rerun setup to regenerate `apiKeyHelper`.
- POSIX config permissions are enforced and checked by doctor.

### Linux

- Install Docker Engine and the Compose v2 plugin.
- Run the installer as the user who owns Claude settings, not root.
- If your user cannot access Docker, fix Docker group/permissions deliberately; do not bypass this by installing the router as root.

### Windows

- Use PowerShell or Windows Terminal and Docker Desktop's WSL2 backend.
- `docker` and `node` must be on PATH.
- POSIX mode bits are not enforced on Windows; use normal Windows user-profile ACLs.
- The CLI passes process arguments as arrays and quotes generated helper paths.

## Upgrades

1. Back up the active data directory.
2. Review the release notes and diff.
3. Test the new checkout with isolated staging.
4. Run offline and container tests.
5. Deploy only after staging succeeds.
6. Run doctor/status and a small verification request.

Configuration hot reload does not reload JavaScript code. Restart the container after an upgrade.

## Uninstall and recovery

```bash
node bin/claude-router.mjs uninstall          # preview
node bin/claude-router.mjs uninstall --apply
```

If settings changed after installation, inspect the warning before using `--force`. Timestamped backups remain under the data directory. To recover manually, stop the router, restore the appropriate `settings-*.bak`, and restart Claude Code.

## Production cautions

- Do not run two routers on the same host port.
- Do not bind the router to a public/LAN interface.
- Do not test upgrades against live settings or the live Compose project.
- Do not store the data directory in source control or synchronized public storage.
- Provider keys and backups remain on the host even after uninstall; remove them securely only when no longer needed.
