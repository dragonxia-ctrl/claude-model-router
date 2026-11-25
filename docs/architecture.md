# Architecture

## Design goals

1. Keep Claude Code unchanged apart from a small, reversible settings patch.
2. Make DeepSeek the safe default; make every Kimi decision explainable.
3. Preserve streaming and Anthropic-compatible request/response behavior.
4. Avoid sending provider credentials to Claude Code or writing them into its settings.
5. Fail closed to DeepSeek when semantic classification fails.
6. Keep the runtime small, dependency-free, and portable.

## Process model

The production topology has three trust zones:

- **Claude Code** on the host, configured to use `http://127.0.0.1:17861`.
- **Router container**, listening on `0.0.0.0` inside its isolated container network but published only on host `127.0.0.1`.
- **DeepSeek and Moonshot HTTPS APIs**, reached over outbound connections.

The host-side CLI is separate from the long-running router. It installs configuration, starts Docker, runs diagnostics, and restores settings. The container itself never edits host Claude settings.

## Modules

### HTTP and configuration

`src/router.mjs` creates the HTTP server and configuration store. `CLAUDE_ROUTER_CONFIG`, `CLAUDE_ROUTER_HOST`, and `CLAUDE_ROUTER_PORT` override defaults for container deployment. On POSIX, SIGHUP reloads configuration; listener address/port changes still require a restart. Code changes always require a restart.

`src/handler.mjs` exposes:

- unauthenticated `GET /health`, which reveals no secrets;
- authenticated `GET /v1/models`;
- authenticated `POST /v1/messages`;
- authenticated `POST /v1/messages/count_tokens`;
- authenticated `POST /v1/router/preview`.

All other routes return 404. Preview resolves a decision without contacting the selected provider, although semantic triage may contact DeepSeek.

### Task identity

`src/task-text.mjs` selects the latest substantive user task. Follow-ups such as “continue” inherit the preceding task. It derives:

- `conversationKey`: a hash of Claude Code metadata and the first user task;
- `taskKey`: a hash of the selected task;
- `followUp`: whether task inheritance was used.

Only hashes are retained in router memory. Raw task text is not logged.

### Deterministic classification

`src/classifier.mjs` first handles explicit provider selection. It then combines benchmark-advantage text rules with progress-based escalation. If no rule matches, DeepSeek is selected and the task becomes a semantic-triage candidate.

### Progress analysis

`src/progress.mjs` pairs tool uses with tool results and classifies calls as read-only, mutating, verification, or other. It tracks failed verification after edits, normalized repeated errors, consecutive failures, repeated identical mutations, and long mutating sequences. The intent is to detect execution difficulty rather than equate activity with difficulty.

### Decision engine

`src/decision-engine.mjs` owns two bounded in-memory maps:

- bounded per-task provider/recovery state, capped at 2,000 conversations;
- semantic decisions, capped at 1,000 task hashes.

Both use insertion-order eviction. They disappear on restart; no conversation database is written to disk.

Resolution order:

1. explicit selection;
2. deterministic evidence/progress result;
3. for a task already on Kimi, bounded sticky routing with checkpoint-based recovery probes;
4. semantic triage for eligible unclassified tasks;
5. DeepSeek fallback.

`src/deescalation.mjs` defines recovery gates and capped exponential backoff. `src/progress.mjs` supplies a recent tool-activity window separate from cumulative escalation statistics. Probe outcomes are committed only after upstream completion: failed DeepSeek probes return to Kimi, while enough successful probes establish a recovered DeepSeek state. Hard capability requirements and explicit selections take precedence. Preview and token counting do not commit state.

### Semantic triage

`src/semantic.mjs` sends only the selected task text, truncated to `triageMaxInputChars`, to DeepSeek. The request uses:

- `max_tokens: 384`;
- `thinking: { type: "disabled" }`;
- `output_config: { effort: "low" }`;
- a system prompt that treats task text as untrusted input.

Thinking is disabled deliberately: allowing the classifier to think can consume the small output budget before it emits JSON. Invalid JSON, invalid providers, low confidence, HTTP errors, and timeouts all result in DeepSeek. Confidence is clamped to `[0, 1]`.

### Provider compatibility

`src/sanitize.mjs` always removes `redacted_thinking` blocks and removes `thinking` blocks when changing providers. This avoids forwarding provider-bound reasoning artifacts to a different upstream.

`src/upstream.mjs` forwards the rewritten request to `${baseUrl}/v1/messages` or the token-count endpoint, sets provider authentication, propagates cancellation, and streams response bytes unchanged. A side-channel usage tap extracts token counters without retaining response text or altering SSE. Router metadata is returned in `x-router-provider` and `x-router-source` response headers.

## Configuration and secrets

The active config contains:

- one local bearer token;
- provider base URLs and model names;
- provider API keys;
- routing thresholds.

Claude Code never receives provider keys. Its `apiKeyHelper` executes a small generated Node script that prints only the local token. The router exchanges requests for provider-authenticated upstream requests.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Invalid local token | 401 before request body processing |
| Missing selected provider key | 503 configuration error |
| Invalid JSON/body | 400 |
| Semantic triage failure | DeepSeek fallback, structured fallback event |
| Invalid hot reload | Keep prior active configuration |
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
