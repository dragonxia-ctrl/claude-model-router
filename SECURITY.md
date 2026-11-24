# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Private vulnerability reporting / Security advisories** feature for this repository. Do not open a public issue for an exploitable problem.

Include:

- affected version or commit;
- operating system, Node.js, Docker, and Claude Code versions;
- reproduction steps using dummy credentials;
- impact and suggested mitigation, if known.

Never include a real API key, local token, private prompt, or full personal config. If credentials were exposed, rotate them immediately with the provider.

This is a community project; responses are best effort. Maintainers will coordinate a fix and disclosure timeline with the reporter.

## Supported versions

Security fixes are applied to the latest commit on the default branch. There are currently no long-term-support branches.

## Secret handling

- DeepSeek and Kimi keys belong only in the active local `config.json`.
- Claude Code receives a separate local router token through `apiKeyHelper`.
- The repository ignores local configs, helper files, manifests, logs, backups, and `.env` files.
- Installer output and router logs must not print provider keys or prompts.
- Do not send production configs in bug reports.

## Data flow and trust boundaries

Prompts and conversation content are sent to DeepSeek or Kimi according to the routing decision. Optional semantic triage additionally sends a truncated copy of the current task text to DeepSeek. Running the router locally does **not** make prompt processing local.

The container is hardened, but Docker itself is a privileged host service. The installer runs on the host and can modify Claude Code settings only after explicit `--apply`.

## Deployment recommendations

- Keep the published port bound to `127.0.0.1`.
- Do not expose the router to a LAN or public interface without adding a separate, reviewed authentication and TLS design.
- Keep the config directory private (`0700`) and config file private (`0600`) on POSIX systems.
- Use Docker's read-only filesystem and capability restrictions from `compose.yaml`.
- Keep backups outside source control.
- Rotate local and provider credentials after suspected exposure.
- Review `settings.json` diffs before using `--force` during uninstall.

See [docs/security.md](docs/security.md) for the threat model and installer rollback details.
