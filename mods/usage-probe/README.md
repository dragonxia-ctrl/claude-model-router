# Usage Probe

A terminal-only Claude Code mod that places real DeepSeek/Kimi token usage and model-request time immediately above the native turn-duration footer.

## Use

Install from this repository's marketplace:

```text
/plugin marketplace add dragonxia-ctrl/claude-model-router
/plugin install usage-probe@claude-model-router
```

Restart Claude Code after installation. For local development without installing:

```bash
claude --plugin-dir "$PWD/mods/usage-probe"
```

After a completed main-conversation turn, the footer shows both models, their token totals and ratios, and their model-request durations and ratios. Use `/router-usage` for input/output/cache details and request counts.

The `Usage` rows describe only the last completed turn, so on their own they lose everything before a context compaction or a continuation. From the second completed turn on, a `Session` block follows them with the same figures summed over every turn of the session, and `/router-usage` prints those session totals too. A cleared or resumed session starts the totals over, as does reloading the mod mid-session.

Token percentages describe accounted token volume, not billed cost. Model time excludes tool execution and other non-model work. Interrupted turns and missing provider usage are explicitly marked partial; missing usage is never converted into a successful zero. Subagent turns are not mixed into the main conversation.

## Validate

```bash
claude plugin validate mods/usage-probe
claude plugin test mods/usage-probe
```

The tests cover mixed-model summaries, an unused model's explicit zero, missing/interrupted usage, subagent isolation, session totals across turns and a session reset, and formatting. They verify that the custom usage rows precede the original `TurnDuration` component. Actual terminal rendering remains dependent on the Claude Code version; this mod does not claim to add the same footer to desktop or IDE surfaces.

See [docs/observability.md](../../docs/observability.md) for router-side health endpoints, Prometheus metrics, and privacy-preserving JSONL telemetry.
