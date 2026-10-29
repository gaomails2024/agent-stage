# Agent Stage · Live status limitations

Honest fidelity for the default 10-agent roster. Adapters are **prewired** to
`FileStatusAdapter` + `public/status/<id>.json` (and `~/.agent-stage/status/` via
the Mac poller). The UI settings path is **UI only** (status art, seats, colors,
background). Do not expect every product to expose a full task-stream API.

Legend:

| Fidelity | Meaning |
|----------|---------|
| **fine** | Real work / session / automation state with usable status mapping |
| **coarse** | App/gateway health or session-file mtime — not full task stream |
| **process-only** | Process / app presence; status stays `idle` unless you drop a status JSON |
| **file-drop** | Only updates when something writes `~/.agent-stage/status/<id>.json` (or public mirror) |
| **none** | No reliable signal found on a typical Mac install |

## Per-agent table

| Agent | Id | How status is obtained | Fidelity | Notes / blockers |
|-------|----|------------------------|----------|------------------|
| WorkBuddy | `workbuddy-1` | `workbuddy.db` automation_runtime / sessions + interactive heartbeats + `PENDING_REVIEW` | **near-official / fine** | Busy + needs_input (pending review). Jobs HTTP optional with token. |
| CodeBuddy | `codebuddy-1` | `codebuddy-sessions.vscdb` status + `automations.db` + coding-copilot `agentState=` log | **near-official** (when status≠Completed) | Do **not** use `:8080` (often Docker). Live `agentState` enum mostly `none`/`idle` when idle; Running statuses appear in sessions DB when chatting. Jobs API still best with token. |
| Hermes Agent | `hermes-1` | Official gateway busy + `gateway_state` / leases / kanban (owned by Hermes dig) | **fine** | Desktop whitelist for presence. |
| DeepSeek Harness | `dsh-1` | Session `turn/start` without `turn/end` in `*.jsonl.zstd`; mtime fallback | **near-official** | Local `:19387` web API exists but needs auth cookie — not scraped. Empty `session.lock` files are leftovers (ignored unless non-empty). No needs_input event found in log schema yet. |
| Grok Bot | `grok-bot-1` | Official `listAgents` (`isRunningTurn` / `awaitingUserResponse`) via host gateway or sand drop | **official** | Prefer Path A gateway; Path B drop TTL 6.5m. Never `/health.isBusy` alone. |
| Marvis | `marvs-1` | `approvals` pending (age-capped) + `main.log` Marvis avatar state / `[streaming]` + tool-results hot | **near-official** | Conversations DB only stores terminal statuses. Stale pending approvals (months old) correctly ignored by age. |
| AutoClaw | `autoclaw-1` | Session `.jsonl.lock` + `task_runs` + open `chat_turn_*` + gateway `state=processing` + bindings | **near-official / fine** | Bindings stay `ready` while working — not used as idle-only. Meets depth bar. |
| 豆包工作 | `doubao-1` | `coding/snapshot` open execution (`endedAtMs` missing) + `trajectory.jsonl` dangling `tool_calls` + `agent_infra` active | **near-official** | Chromium profile has no public HTTP status; saman_app_state is window visibility only. |
| Claude Code | `claude-code-1` | `claude agents --json` + project transcript mtime; hooks for fine needs_input | **near-official** (busy via CLI) / **hooks** for needs_input | Empty hooks today → no needs_input without installing `examples/hooks/claude-status-write.sh`. |
| Codex | `codex-1` | `thread_history` in-progress turns + unresolved `exec_command` calls with `sandbox_permissions=require_escalated` / `request_user_input`; `threads.rollout_path` locates each session | **near-official** | Approval prompt is inferred from a call that has no output/`item_completed` yet. The history DB decides that a call started; the logs DB is only an accelerator and may rotate. Unresolved prompts stay `needs_input` even when the rollout is quiet; a stale in-progress row with a 30-minute-quiet rollout is ignored for `running`. |


## Presence model (fundamental)

**Online / offline presence is decided only by a main-app binary whitelist**
(`APP_MAINS` in `scripts/bridges/macos-live-status-poll.mjs` via `appMainRunning`).
Candidates are exact `Something.app/Contents/MacOS/…` (or known CLI) path
fragments with a trailing boundary — never bare brand substrings. Helpers
(GPU/Renderer), crashpad, CLI shims inside another product's tree, launchd-only
gateways without the desktop app (Hermes), and HTTP health alone do **not** count
as "app up". Rules for every roster agent: **offline** = whitelist miss;
**idle** = app up, no fresh work signal; **running** = app up + live work signal;
**needs_input / needs_auth** = explicit signals only. Grok Bot is the exception:
prefer a fresh heartbeat file; fall back to `Grok Bot.app` main binary only.

## Mac poller

```bash
node scripts/bridges/macos-live-status-poll.mjs          # loop
node scripts/bridges/macos-live-status-poll.mjs --once   # one shot
```

Writes both:

- `~/.agent-stage/status/<id>.json`
- `<project>/public/status/<id>.json` (Vite `/status/…` for the browser UI)

## Grok Bot heartbeat (example)

```bash
mkdir -p ~/.agent-stage/status
cat > ~/.agent-stage/status/grok-bot.json <<'JSON'
{
  "schemaVersion": 1,
  "agentId": "grok-bot-1",
  "status": "running",
  "summary": "Grok Bot: implementing Agent Stage",
  "observedAt": "2026-10-20T04:00:00.000Z",
  "vendor": "grok-bot"
}
JSON
```

## Config import on Mac

`public/config.override.json` uses `forceVersion`. When the version string changes,
the app imports the new 10-agent roster **once** into localStorage / Tauri config.
Your later UI edits are kept until the next version bump.

To reset manually: clear `localStorage` key `agent-stage-config` and
`agent-stage-force-version`, then reload.

## Explicit non-goals

- Free-form drag-and-drop seat repositioning (use 坐席 # + 坐席侧).
- Inventing fake live APIs for closed products.
- Requiring users to configure adapter modes for normal use.
