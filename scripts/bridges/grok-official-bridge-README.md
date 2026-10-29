# Grok Bot official status bridge

**Canonical busy signal:** `POST {gatewayUrl}/api/listAgents`  
Desktop mapping: `needs_input` iff `awaitingUserResponse != null`; else `running` iff `!isGroup && (isRunning || isRunningTurn || isComposingMessage)`; else `idle`.  
Do **not** use `/health.isBusy` alone (can be false while Coder `isRunning`).

## Path A (preferred, when available)
Mac poller calls listAgents if `GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN` are set, **or** `~/.agent-stage/grok-gateway.json` exists (`{ "gatewayUrl", "gatewayToken" }`).  
Grok Bot desktop keeps gateway stamped in memory / sealed files — **not** readable as plaintext on disk today (`desktop-status.json` has no busy/gateway fields; `sand-client-persistence` strips `isRunningTurn`).

## Path B (interim)
Box exporter: `node scripts/bridges/grok-official-status-export.mjs`  
Writes `.runtime/grok-bot-official.json`. Push that JSON to Mac `~/.agent-stage/status/grok-bot.json` with `meta.source=sand-listAgents` (≤90s TTL). Continuous push needs a Grok Bot routine (~30s) until Path A works.
