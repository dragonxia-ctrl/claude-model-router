# Architecture

## Design goals

1. Keep Claude Code unchanged apart from a small, reversible settings patch.
2. Make DeepSeek the safe default; make every Kimi decision explainable.
3. Preserve streaming and Anthropic-compatible request/response behavior.
4. Avoid sending provider credentials to Claude Code or writing them into its settings.
5. Fail closed to DeepSeek when semantic classification fails.
6. Keep the runtime small, dependency-free, and portable.

## Process model

The router runs as one Node process in one of three install modes: a macOS
launchd service, a direct Node process, or a container. It listens on
`127.0.0.1:17861` by default.

The production topology has three trust zones:

- **Claude Code** on the host, configured to use `http://127.0.0.1:17861`.
- **Router process** on the host. Direct Node and launchd installs bind loopback
  directly; container mode listens on `0.0.0.0` inside an isolated container
  network that is published only on host `127.0.0.1`.
- **DeepSeek and Moonshot HTTPS APIs**, reached over outbound connections.

The host-side CLI is separate from the long-running router. It installs configuration, starts the service or container, runs diagnostics, and restores settings. In container mode the container never edits host Claude settings; native installs are managed by the same CLI.

## Modules

### HTTP and configuration

`src/router.mjs` creates the HTTP server and configuration store. `CLAUDE_ROUTER_CONFIG`, `CLAUDE_ROUTER_HOST`, and `CLAUDE_ROUTER_PORT` override defaults for container deployment. On POSIX, SIGHUP reloads configuration; listener address/port changes still require a restart. Code changes always require a restart.

`src/handler.mjs` and `src/health.mjs` expose:

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | None | Legacy summary; includes the running release |
| `GET /health/live` | None | Process liveness and uptime |
| `GET /health/ready` | None | Configuration/provider readiness; 503 when no provider is configured |
| `GET /health/deep` | Local bearer token | Configuration, last upstream outcomes, telemetry health |
| `GET /version` | None | Running and latest release from the local cache |
| `GET /metrics`, `GET /metrics/json` | Local bearer token | Prometheus text or JSON telemetry snapshot; 503 when telemetry is disabled |
| `GET /v1/models` | Local bearer token | Anthropic-compatible model listing |
| `GET /v1/router/state` | Local bearer token | In-memory residency and probe state |
| `POST /v1/router/deescalate` | Local bearer token | Schedule a recovery checkpoint |
| `POST /v1/messages` | Local bearer token | Main Messages request |
| `POST /v1/messages/count_tokens` | Local bearer token | Token counting |
| `POST /v1/router/preview` | Local bearer token | Resolve a decision without forwarding the request |

All other routes return 404. Preview resolves a decision without forwarding to the selected provider, although semantic triage may contact DeepSeek. Preview and token counting never commit routing state.

`src/http-utils.mjs` handles local token authentication, JSON/error responses, and the 128 MiB request-body limit. `src/views.mjs` renders the legacy health summary and `/v1/models`. `src/health.mjs` owns liveness, readiness, and deep diagnostics.

### Task identity

`src/task-text.mjs` selects the latest substantive user task. Follow-ups such as “continue” inherit the preceding task. It derives:

- `conversationKey`: a hash of `metadata.user_id`, the 16-hex session tag, and the first user task;
- `taskKey`: a hash of the selected task;
- `followUp`: whether task inheritance was used.

Only hashes are retained in router memory. Raw task text and the session UUID are not logged.

### Deterministic classification

`src/classifier.mjs` first handles explicit provider selection: a leading `[kimi]`/`[deepseek]` marker, a leading `force`/`强制` command, or a model alias (`kimi*`, `claude-opus*`, `claude-fable*` select Kimi; `deepseek*`, `claude-haiku*` select DeepSeek). Ordinary prose such as “use kimi” is not an instruction. It then combines benchmark-advantage text rules with progress-based escalation. If no rule matches, DeepSeek is selected and the task becomes a semantic-triage candidate.

Benchmark text heuristics and semantic triage apply only to interactive streaming requests (`stream: true`); auxiliary non-streaming calls do not use those text rules or triage. Progress escalation and media capability checks still apply to either kind. An actual video media block is the only hard Kimi-only capability; an image block or a text mention of video does not lock routing.

### Progress analysis

`src/progress.mjs` pairs tool uses with tool results and classifies calls as read-only, mutating, verification, or other. It tracks failed verification after edits, normalized repeated errors, consecutive failures, repeated identical mutations, and long mutating sequences. The intent is to detect execution difficulty rather than equate activity with difficulty.

### Decision engine

`src/decision-engine.mjs` owns two bounded in-memory maps:

- bounded per-task provider/recovery state keyed by `(conversationKey, taskKey)`, capped at 2,000 keys;
- semantic decisions, capped at 1,000 task hashes.

Both use insertion-order eviction. They disappear on restart; no conversation database is written to disk.

Resolution order:

1. explicit selection;
2. deterministic evidence/progress result;
3. for a task already on Kimi, bounded sticky routing with checkpoint-based recovery probes;
4. semantic triage for eligible unclassified tasks;
5. DeepSeek fallback.

`src/deescalation.mjs` defines recovery gates, probe failure classes, relapse confirmation, and capped exponential backoff. `src/progress.mjs` supplies a recent tool-activity window separate from cumulative escalation statistics. Probe outcomes are committed only after upstream completion: failed DeepSeek probes return to Kimi with a class-specific response (availability failures do not consume the quality attempt budget), while enough successful probes establish a recovered DeepSeek state. `src/latency.mjs` keeps process-wide per-provider generation-speed and TTFB baselines; it only influences routing when the optional latency checkpoint is enabled. Hard capability requirements and explicit selections take precedence. Preview and token counting do not commit state.

### Semantic triage

`src/semantic.mjs` sends only the selected task text, truncated to `triageMaxInputChars`, to DeepSeek. The request uses:

- `max_tokens: 384`;
- `thinking: { type: "disabled" }`;
- `output_config: { effort: "low" }`;
- a system prompt that treats task text as untrusted input.

Thinking is disabled deliberately: allowing the classifier to think can consume the small output budget before it emits JSON. Invalid JSON, invalid providers, low confidence, HTTP errors, and timeouts all result in DeepSeek. Confidence is clamped to `[0, 1]`.

### Provider compatibility

For a DeepSeek target or a provider switch, `src/sanitize.mjs` removes `redacted_thinking` blocks; a provider switch also removes provider-bound `thinking` blocks. On every DeepSeek request it guarantees a `thinking` block on every assistant turn: an existing block is preserved, a plain-string turn becomes a thinking + text block array, and a tool-only or replayed turn receives an empty placeholder. DeepSeek's thinking mode rejects a tool-use history when any assistant turn lacks that block.

`src/upstream.mjs` forwards the rewritten request to `${baseUrl}/v1/messages` or the token-count endpoint, sets provider authentication, propagates cancellation, and streams response bytes unchanged. A side-channel usage tap extracts token counters without retaining response text or altering SSE. Router metadata is returned in `x-router-provider` and `x-router-source` response headers.

### Side channels

`src/session.mjs` derives a 16-hex session tag from the `x-claude-code-session-id` header or the session id inside `metadata.user_id`; only the tag is logged, never the UUID.

`src/activity.mjs` turns the `started`, `route_decision`, and `request_complete` lines in `router.log` into per-session in-flight requests and 2-second activity cells. Cells are sampled on a fixed grid, so a block on a request boundary does not change colour between renders.

`src/status-line.mjs` is the Claude Code status-line command. It reads `session_id` from stdin and only local files: `router.log`, `config.json`, `version-cache.json`, and `auto-update-state.json`. Its label is padded to a fixed width so the strip starts at the same column for every provider. When the cached release check is older than ten minutes it starts a throttled, detached `scripts/version-status.mjs --refresh` child, which is the only network caller on this path. Rendering itself never blocks a request.

`src/version.mjs` checks GitHub `releases/latest`, then the `package.json` version on `main`, then tags, at startup and at most every 30 minutes. It writes `version-cache.json` atomically and merges fields owned by the router, status-line refresher, and updater. A failed check keeps the last known release.

`src/auto-update.mjs` runs the periodic automatic-update tick. When `updates.auto` is on, it reuses the cached release check and starts `scripts/router-update.mjs --auto-install` as a detached process, writes `auto-update-state.json` (`running`, `ok`, `failed`), appends output to `auto-update.log`, and backs off for an hour after a failure. The updater verifies a clean `main` checkout and matching version, runs the offline tests, backs up, deploys, restarts, verifies health/`/version`/preview, and rolls back on failure. Docker installs are not updated automatically.

`src/telemetry.mjs` keeps bounded in-memory request/token metrics for `/metrics` and `/metrics/json` and can persist pseudonymous JSONL records. `src/usage.mjs` tees provider-reported usage from JSON or SSE while forwarding every response byte unchanged. See [observability.md](observability.md).

## Configuration and secrets

The active config contains:

- one local bearer token;
- provider base URLs and model names;
- provider API keys;
- routing thresholds.

Claude Code never receives provider keys. Its `apiKeyHelper` executes a small generated Node script that prints only the local token. The router exchanges requests for provider-authenticated upstream requests.

Non-secret runtime state lives beside the config: `router.log`, `version-cache.json`, `auto-update-state.json`, `auto-update.log`, and optionally the telemetry JSONL directory. None of them contains prompts, session UUIDs, or provider keys.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Invalid local token | 401 before request body processing |
| Missing selected provider key | 503 configuration error |
| Invalid JSON/body | 400 |
| Semantic triage failure | DeepSeek fallback, structured fallback event |
| Invalid hot reload | Keep prior active configuration |
| DeepSeek recovery probe upstream failure | Return to Kimi and increase residency up to `maxBackoffRequests` |
| Version check offline or failed | Keep the last known release, record the attempt, and do not retry in a loop |
| Auto-update install or verification failure | Roll back the deployment, record `failed`, and retry no sooner than one hour |
| Status-line refresh failure | Silent; the local render and request path are unaffected |
| Docker startup/health failure during install | Restore pre-install files and stop the partial deployment |
| Upstream stream failure after headers | Destroy the downstream response; cannot safely synthesize a second response |

## Non-goals

- a general-purpose LLM gateway;
- persistent conversation storage;
- centralized multi-user authentication;
- automatic provider additions;
- a guarantee that a benchmark category predicts every individual task;
- hiding the fact that prompts leave the local machine.

Only DeepSeek and Kimi are currently supported.
