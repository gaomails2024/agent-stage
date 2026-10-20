# Agent Stage · Live status limitations

Honest fidelity for the default roster. Adapters are typically wired to
`FileStatusAdapter` + `public/status/<id>.json` (and `~/.agent-stage/status/` via
the Mac poller). The UI settings path is **UI only** (status art, seats, colors,
background). Do not expect every product to expose a full task-stream API.

Legend:

| Fidelity | Meaning |
|----------|---------|
| **fine / near-official** | Real work / session / automation state with usable status mapping |
| **coarse** | App/gateway health or session-file mtime — not full task stream |
| **process-only** | Process / app presence; status stays `idle` unless you drop a status JSON |
| **file-drop / hooks** | Only updates when something writes `~/.agent-stage/status/<id>.json` (or public mirror) |
| **none** | No reliable signal found on a typical Mac install |

## Per-agent table

| Agent | Id | How status is obtained | Fidelity | Notes / blockers |
|-------|----|------------------------|----------|------------------|
| WorkBuddy | `workbuddy-1` | `workbuddy.db` automation_runtime / sessions + interactive heartbeats + `PENDING_REVIEW` | **near-official / fine** | Busy + needs_input (pending review). Jobs HTTP optional with token. |
| CodeBuddy | `codebuddy-1` | `codebuddy-sessions.vscdb` status + `automations.db` + coding-copilot `agentState=` log | **near-official** (when status≠Completed) | Do **not** assume `:8080` is the Jobs API (often unrelated). Jobs API still best with token. |
| Hermes Agent | `hermes-1` | Gateway busy + `gateway_state` / leases / kanban (see poller) | **fine** for busy; **gaps** for wait | Desktop whitelist for presence. **Gap:** in-memory gateway command approvals / `LiveSessionStatus.waiting` are **not** on the control socket — only kanban `needs_input` + recent `pending/{memory,skills}` writes. |
| DeepSeek Harness | `dsh-1` | Session `turn/start` without `turn/end` in `*.jsonl.zstd`; mtime / await-user heuristics | **near-official** | Local web API may need auth cookie — not scraped by default. |
| Grok Bot | `grok-bot-1` | Official `listAgents` (`isRunningTurn` / `awaitingUserResponse`) via ops gateway or sand drop | **official** when Path A/B works | Prefer Path A gateway; Path B drop TTL ~90s–6.5m depending on path. Never `/health.isBusy` alone. Optional `GROK_CODER_AGENT_ID` to prefer a specific agent id; else name `Coder`. |
| Marvis | `marvs-1` | `approvals` pending (age-capped) + `main.log` state / `[streaming]` | **near-official** | Conversations DB often only stores terminal statuses. Stale pending approvals ignored by age. |
| AutoClaw | `autoclaw-1` | Session `.jsonl.lock` + `task_runs` + open `chat_turn_*` + gateway `state=processing` | **near-official / fine** | Bindings can stay `ready` while working — not used as idle-only. |
| 豆包工作 | `doubao-1` | `coding/snapshot` open execution + `trajectory.jsonl` dangling tool_calls + `agent_infra` | **near-official** for **running** | **Gap:** poller does **not** currently emit `needs_input` — no reliable public wait/approval signal found; app online without open execution → `idle`. |
| Claude Code | `claude-code-1` | `claude agents --json` + project transcript mtime; **hooks** for fine wait | **near-official** busy / **hooks** for needs_input | Without installing `examples/hooks/claude-status-write.sh`, permission waits stay invisible (seat may show idle/running only). |
| Codex | `codex-1` | Rollout `task_started` without `task_complete`; rollout/session mtime; permission event heuristics | **near-official** | Matcher includes `rollout-*.jsonl`. Interactive approval coverage still weaker than Claude hooks. |

Characters such as Kimi / GLM may exist as art assets; they are not in the default 10-agent `DEFAULT_ROSTER_SPEC` unless you add them in Settings.

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
prefer a fresh heartbeat / listAgents path; fall back to `Grok Bot.app` main binary only.

## Mac poller (high level)

```bash
pnpm bridge:live                 # loop
pnpm bridge:live:once            # one shot
# node scripts/bridges/macos-live-status-poll.mjs [--once] [--interval 2000]
```

Each tick:

1. Snapshot process list (`ps`) and match `APP_MAINS` whitelist → online/offline.
2. Per vendor: read local DBs / session logs / optional localhost APIs (never invent fake APIs).
3. Map into Stage states: `idle | running | needs_auth | needs_input | done | error` (+ `offline` for presence).
4. Atomically write both:
   - `~/.agent-stage/status/<id>.json`
   - `<project>/public/status/<id>.json` (Vite `/status/…` for the browser UI)

**Platform:** macOS-oriented paths (`~/Library/...`, `.app` bundles). On other OSes use Mock / hand-written JSON.

## Known gaps (summary)

| Area | Reality |
|------|---------|
| Hermes waits | In-memory gateway approvals / live session “waiting” **not** exported on the control socket |
| Claude waits | Need hooks → snapshot file; CLI/transcript alone ≈ busy/idle |
| 豆包 waits | `needs_input` **weak / absent** in current poller |
| Closed products | No scraping of private sealed stores beyond documented file/CLI surfaces |

## Grok Bot heartbeat (example)

```bash
mkdir -p ~/.agent-stage/status
cat > ~/.agent-stage/status/grok-bot.json <<'JSON'
{
  "schemaVersion": 1,
  "agentId": "grok-bot-1",
  "status": "running",
  "summary": "Grok Bot: example work summary",
  "observedAt": "2026-10-20T04:00:00.000Z",
  "vendor": "grok-bot"
}
JSON
```

## Config import (`forceVersion`)

`public/config.override.json` may include `forceVersion` (this repo uses a public
marker such as `oss-roster-v1`). When the version string **changes**, the app
imports the override roster **once** into localStorage / Tauri config. Your later
UI edits are kept until the next version bump.

To reset manually: clear `localStorage` keys `agent-stage-config` and
`agent-stage-force-version`, then reload.

## Explicit non-goals

- Free-form drag-and-drop seat repositioning (use 坐席 # + 坐席侧).
- Inventing fake live APIs for closed products.
- Requiring users to configure adapter modes for normal UI use.
