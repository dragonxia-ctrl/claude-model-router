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

Files are named `requests-YYYY-MM-DD[-n].jsonl`, created with owner-only permissions, rotated at `maxFileBytes`, and cleaned by age according to `retentionDays`. Rotation limits each file, not the total daily volume. A bounded write buffer drops records rather than blocking request traffic; drops and write errors are visible in telemetry. If the salt or directory cannot be initialized, persistence is disabled instead of crashing the router.

## Terminal usage probe

`mods/usage-probe` is a Claude Code terminal mod. It renders real per-model token consumption and model-request time immediately above the native `TurnDuration` footer (for example, `Churned for 22s · done ...`). It also provides `/router-usage` for a detailed breakdown.

```text
Usage · DeepSeek 6.5k tok · 93% tok · 0.0s · 0% time
        Kimi     500 tok  · 7% tok  · 0.0s · 0% time
Churned for 22s · done Tuesday 22:53
```

The displayed token total is the sum of input, output, cache-read, and cache-creation tokens. It is an accounted token-volume ratio, **not a price or billed-cost ratio**. Model time is measured around each `turn.step`; turn wall time also includes tools and other non-model work. Both router models are shown, including an explicit zero for an unused model. Missing usage is labeled `usage unavailable`/`partial usage`, and interrupted turns are labeled partial rather than silently treated as complete. Subagent traffic is excluded from the main-conversation summary.

The footer integration is terminal-only; desktop and IDE surfaces do not use the terminal `TurnDuration` renderer. Plugin tests verify component ordering, but rendering can remain version-dependent across Claude Code releases.

Development and validation:

```bash
claude plugin validate mods/usage-probe
claude plugin test mods/usage-probe
claude --plugin-dir "$PWD/mods/usage-probe"
```

The mod observes usage already returned to Claude Code. It does not need provider keys, does not call the router management endpoints, and does not persist prompts or responses.
