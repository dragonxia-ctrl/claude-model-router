# Health, Metrics, and Usage Probe

## Health model

The router separates process liveness, configuration readiness, and detailed diagnostics. None of the health endpoints makes an active provider request or spends provider tokens.

| Endpoint | Authentication | Purpose | Failure status |
| --- | --- | --- | --- |
| `GET /health/live` | None | Process is running; includes version and uptime | Always 200 once the HTTP server is available |
| `GET /health/ready` | None | Configuration loaded and at least one provider has a key | 503 when no provider is configured |
| `GET /health/deep` | Local bearer token | Provider configuration, latest upstream result, routing revision, telemetry/persistence health | Reports `not_ready` when configuration is incomplete |
| `GET /health` | None | Legacy health summary | Kept for compatibility |

`ready` means both providers are configured; `degraded` means at least one is configured and another is missing. These checks do not claim that provider DNS, credentials, quotas, or networks are currently healthy. Latest upstream outcomes provide passive evidence without adding cost.

Examples:

```bash
curl http://127.0.0.1:17861/health/live
curl http://127.0.0.1:17861/health/ready
curl -H "Authorization: Bearer $CLAUDE_ROUTER_LOCAL_TOKEN" \
  http://127.0.0.1:17861/health/deep
```

Keep detailed endpoints on the loopback interface. They expose operational metadata and must not be published to a shared network.

## Request telemetry and Prometheus

Telemetry is enabled in memory by default. It records:

- request count, outcome, duration, upstream time to first byte, and response bytes;
- actual reported input, output, cache-read, and cache-creation tokens;
- route provider/source, escalations, and de-escalation outcomes;
- semantic-triage usage separately from main requests;
- persistence write/drop/error counts.

No response text, prompt text, file content, provider API key, local bearer token, or authorization header is recorded. Conversation/task identifiers are HMAC pseudonyms in persisted JSONL, using a private random salt. Metric labels are bounded and contain no task text.

| Endpoint | Authentication | Format |
| --- | --- | --- |
| `GET /metrics` | Local bearer token | Prometheus text exposition |
| `GET /metrics/json` | Local bearer token | JSON snapshot for local tooling |

Important metric families:

- `claude_router_requests_total{provider,model,purpose,outcome}`
- `claude_router_request_duration_seconds`
- `claude_router_upstream_ttfb_seconds`
- `claude_router_tokens_total{provider,model,type}`
- `claude_router_route_decisions_total{provider,source,purpose}`
- `claude_router_escalations_total{from_provider,to_provider,source}`
- `claude_router_deescalation_total{outcome}`
- `claude_router_telemetry_dropped_records_total`

In-memory counters reset on restart. The usage tap reads provider-reported usage from JSON or SSE while forwarding every response byte unchanged.

### Route decision log fields

Each routed request writes one `route_decision` JSON line to `router.log`:

| Field | Meaning |
| --- | --- |
| `provider`, `model`, `source`, `reason` | Chosen upstream and why |
| `stream` | Whether the client asked for a streaming response; only `stream: true` requests are treated as interactive for benchmark text heuristics |
| `stats` | Tool-history counters behind progress escalation |
| `conversationKey`, `taskKey` | Pseudonymous session/task identifiers for replay and correlation |
| `capabilityKinds`, `hardCapability`, `media` | Which benchmark/capability rules fired, whether any of them blocks de-escalation, and which media block kinds were actually present (`video`, `image`) |
| `deescalationOutcome` | Probe, relapse, blocked-window, or capability-block outcome |

Prompts, file contents, and API keys are never logged. `media` is a boolean pair, not a media payload, so the log answers "did this request really contain video" without storing it.

### Optional JSONL persistence

Manual Node deployments can set:

```json
{
  "telemetry": {
    "persist": true,
    "directory": "/absolute/private/telemetry-directory",
    "retentionDays": 30,
    "maxFileBytes": 33554432
  }
}
```

`CLAUDE_ROUTER_TELEMETRY_DIR` overrides the directory and enables persistence. Set `CLAUDE_ROUTER_TELEMETRY=0` to disable telemetry collection. The supplied Compose deployment sets `CLAUDE_ROUTER_TELEMETRY_DIR=/telemetry`, so it persists to the `router-telemetry` named volume by default.

Files are named `requests-YYYY-MM-DD[-n].jsonl`, created with owner-only permissions on POSIX (Windows uses the private data directory's ACL), rotated at `maxFileBytes`, and cleaned by age according to `retentionDays`. Rotation limits each file, not the total daily volume. A bounded write buffer drops records rather than blocking request traffic; drops and write errors are visible in telemetry. If the salt or directory cannot be initialized, persistence is disabled instead of crashing the router.

## Version and update visibility

`GET /version` answers without authentication and without waiting on the network:

```json
{
  "current": "1.2.0",
  "latest": "v1.2.0",
  "status": "current",
  "updateAvailable": false,
  "checkedAt": "2026-11-25T13:50:00.000Z",
  "repository": "dragonxia-ctrl/claude-model-router"
}
```

`status` is `current` when the running release matches the latest release, `available` when a newer release exists, `ahead` when the running build is newer than anything published, and `unknown` when no release information has been fetched yet. `GET /health` also carries the running release as `release`.

The router checks the public GitHub `releases/latest` endpoint of its own repository (falling back to the `package.json` version on `main` through the GitHub contents API, then its tag list) at startup and at most once every six hours, caches the result in `version-cache.json` next to `config.json` (override with `CLAUDE_ROUTER_VERSION_CACHE`), and serves the cached answer to `/version`. A failed or unreachable lookup is silent: the endpoint still reports the running release with `status: "unknown"`. No prompts, tool history, keys, or local identifiers are sent — the update check is a single unauthenticated GitHub read, exactly like an application checking its own release feed. `claude-router version` prints the same state outside Claude Code.

### Status line inside Claude Code

`scripts/version-status.mjs` formats that cache for Claude Code's native status line, which is where Claude Code itself shows its version and upgrade notices:

```json
"statusLine": {
  "type": "command",
  "command": "node \"$HOME/.claude/model-router/version-status.mjs\""
}
```

It prints `router v1.2.0 · latest v1.2.0` dimmed, or `router v1.2.0 · v1.3.0 available` in amber when an upgrade exists, and nothing at all when the router has never written a version cache. The helper performs no I/O beyond reading that one file, so it is safe on every status line refresh. Mods such as the usage probe run in a sandbox without `fetch`, `process`, or filesystem access, which is why version visibility uses the status line rather than the turn footer.

## Terminal usage probe

`mods/usage-probe` is a Claude Code terminal mod. It renders real per-model token consumption and model-request time immediately above the native `TurnDuration` footer (for example, `Churned for 22s · done ...`). It also provides `/router-usage` for a detailed breakdown.

```text
Usage · DeepSeek 6.5k tok · 93% tok · 0.0s · 0% time
        Kimi     500 tok  · 7% tok  · 0.0s · 0% time
Churned for 22s · done Tuesday 22:53
```

The displayed token total is the sum of input, output, cache-read, and cache-creation tokens. It is an accounted token-volume ratio, **not a price or billed-cost ratio**. Model time is measured around each `turn.step`; turn wall time also includes tools and other non-model work. Both router models are shown, including an explicit zero for an unused model. Missing usage is labeled `usage unavailable`/`partial usage`, and interrupted turns are labeled partial rather than silently treated as complete. Subagent traffic is excluded from the main-conversation summary.

The footer integration is terminal-only; desktop and IDE surfaces do not use the terminal `TurnDuration` renderer. Plugin tests verify component ordering, but rendering can remain version-dependent across Claude Code releases.

Install it from the repository marketplace, then restart Claude Code:

```text
/plugin marketplace add dragonxia-ctrl/claude-model-router
/plugin install usage-probe@claude-model-router
```

Development and validation:

```bash
claude plugin validate mods/usage-probe
claude plugin test mods/usage-probe
claude --plugin-dir "$PWD/mods/usage-probe"
```

The mod observes usage already returned to Claude Code. It does not need provider keys, does not call the router management endpoints, and does not persist prompts or responses.
