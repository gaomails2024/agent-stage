# Grok Bot official status bridge

**Canonical busy signal:** `POST {gatewayUrl}/api/listAgents`  
Desktop mapping: `needs_input` iff `awaitingUserResponse != null`; else `running` iff `!isGroup && (isRunning || isRunningTurn || isComposingMessage)`; else `idle`.  
Do **not** use `/health.isBusy` alone (can be false while Coder `isRunning`).

## Path A (preferred, when available)
Mac poller calls listAgents if `GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN` are set, **or** `~/.agent-stage/grok-gateway.json` exists (`{ "gatewayUrl", "gatewayToken" }`).  
Grok Bot desktop keeps gateway stamped in memory / sealed files — **not** readable as plaintext on disk today (`desktop-status.json` has no busy/gateway fields; `sand-client-persistence` strips `isRunningTurn`).

## Path B (interim)
Host exporter (optional): `node scripts/bridges/grok-official-status-export.mjs`  
Reads `GROK_GATEWAY_JSON` or `~/.agent-stage/grok-gateway-host.json` (`{ port, token, scheme? }`).  
Writes `<repo>/.runtime/grok-bot-official.json` (gitignored). Push that JSON to Mac
`~/.agent-stage/status/grok-bot.json` with `meta.source=sand-listAgents` (short TTL).  
Optional: `GROK_CODER_AGENT_ID` to prefer a specific agent id; else name `Coder`.
