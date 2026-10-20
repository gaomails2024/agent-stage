# Agent Stage · Live signals reference

Source of truth for this table: `scripts/bridges/macos-live-status-poll.mjs`
(and optional bridges under `scripts/bridges/`). Do not treat this as a guarantee
from vendor public APIs — only what **this repo’s poller actually reads**.

Related: [LIMITATIONS.md](./LIMITATIONS.md) (fidelity / gaps), [status-ingest.md](./status-ingest.md) (protocol), [macos.md](./macos.md) (how to run).

## Shared model

| Concern | Behavior in Mac poller |
|---------|------------------------|
| **Presence (online/offline)** | `APP_MAINS` whitelist vs `ps` — exact `.app/Contents/MacOS/…` or known CLI fragments with a path boundary. Helpers / bare brand substrings do **not** count. |
| **Output** | Atomic write to `~/.agent-stage/status/<id>.json` **and** `<repo>/public/status/<id>.json` |
| **States** | `offline` \| `idle` \| `running` \| `needs_input` \| `needs_auth` \| `done` \| `error` |
| **Platform** | macOS-oriented paths (`~/Library/...`, `.app` bundles) |

`needs_auth` is rarely set by the Mac live poller itself. The optional Jobs bridge
(`buddy-jobs-poll.mjs`) maps HTTP 401/403 → `needs_auth`. Grok can pass through a
drop file status that already says `needs_auth`.

---

## Per-agent signals

### WorkBuddy (`workbuddy-1`)

| | |
|--|--|
| **Presence** | `WorkBuddy.app/Contents/MacOS/Electron` |
| **Primary sources** | `~/.workbuddy/workbuddy.db`; interactive session heartbeats under `~/.workbuddy/sessions/` |
| **Busy (`running`)** | `automation_runtime_state.running=1`; live interactive session heartbeat; or session row status in `{running,working,active,in_progress,busy}` |
| **`needs_input`** | Recent `automation_runs` with `PENDING_REVIEW` (age-capped, not failed/cancelled); or session status in `{waiting,blocked,needs_input,pending}` |
| **Other** | Recent `completed` → short `done` window then `idle`; `failed`/`error`/`terminated` → `error` |
| **Optional bridge** | `buddy-jobs-poll.mjs --vendor workbuddy` (Jobs HTTP when `--serve` + token) |
| **Gaps** | Without DB + app, coarse idle/offline only |

### CodeBuddy (`codebuddy-1`)

| | |
|--|--|
| **Presence** | `CodeBuddy CN.app` / `CodeBuddy.app` Electron or CodeBuddy main |
| **Primary sources** | `automations.db`; `codebuddy-sessions.vscdb` ItemTable; coding-copilot log `agentState=` |
| **Busy** | Automation status busy-like; session status not Completed; or log `agentState` not in `{none,idle,stop,stopped}` |
| **`needs_input`** | Automation/session status in `{waiting,blocked,pending_review,needs_input,pending}` |
| **Optional bridge** | `buddy-jobs-poll.mjs --vendor codebuddy` |
| **Gaps** | Poller deliberately does **not** probe `:8080` (often unrelated Docker). Jobs API is separate / better with token |

### Hermes Agent (`hermes-1`)

| | |
|--|--|
| **Presence** | Desktop only: `hermes-agent/apps/desktop/…` or `Hermes.app/Contents/MacOS/Hermes` (not Hermes-Setup). launchd gateway alone ≠ online |
| **Primary sources** | `~/.hermes/gateway.sock` verb=`status` (preferred) or `gateway_state.json`; `state.db` turn leases; `kanban.db`; `pending/{memory,skills}/*.json` |
| **Busy** | Official: `gateway_state ∈ {running,degraded}` **and** `active_agents > 0`; also unexpired `session_turn_leases` |
| **`needs_input`** | Kanban `status=blocked` + `block_kind=needs_input`; and/or recent pending write-approval JSON under `pending/memory` or `pending/skills` (24h) |
| **Optional bridge** | `hermes-poll.mjs` (HTTP `/api/sessions` if API server + key) |
| **Gaps** | **In-memory gateway command approvals / `LiveSessionStatus.waiting` are not on the control socket** — those waits stay invisible |

### DeepSeek Harness (`dsh-1`)

| | |
|--|--|
| **Presence** | `DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` |
| **Primary sources** | `~/.dsh/sessions/**/*.jsonl.zstd` streamed for open `turn/start` without `turn/end`; session/lock mtime fallback |
| **Busy** | Open turn; or session/lock mtime &lt; ~90s |
| **`needs_input`** | Heuristic: app up + warm session / recent closed turn, **no** open turn → `await-user` |
| **Gaps** | Local `:19387` web API (if present) needs auth cookie — **not** scraped by default. No dedicated needs_auth path |

### Grok Bot (`grok-bot-1`)

| | |
|--|--|
| **Presence** | `Grok Bot.app/Contents/MacOS/Grok Bot` (or live `desktop-status.json` pid) |
| **Primary sources** | **Path A:** `listAgents` via `GROK_BOT_GATEWAY_URL`+`TOKEN` or `~/.agent-stage/grok-gateway.json`. **Path B:** drop `~/.agent-stage/status/grok-bot.json` with `meta.source` matching sand/listAgents (TTL ~6.5m for official; ~90s otherwise) |
| **Busy** | From listAgents / drop: `isRunning` / `isRunningTurn` / `isComposingMessage` (non-group); never `/health.isBusy` alone |
| **`needs_input`** | `awaitingUserResponse != null` on Coder (or any agent) |
| **Optional** | `GROK_CODER_AGENT_ID` to pin agent id; else name `Coder`. Exporter: `grok-official-status-export.mjs` |
| **Gaps** | Without Path A/B, seat stays **idle while app online** (“细忙碌待官方状态信号”) |

### Marvis (`marvs-1`)

| | |
|--|--|
| **Presence** | `Marvis.app/Contents/MacOS/Marvis` |
| **Primary sources** | Approvals under MarvisData User tree; `~/Library/Logs/com.tencent.mac.marvis/main.log`; workspace mtime; optional KB `127.0.0.1:5151/health` (annotate idle only) |
| **Busy** | Log streaming / working-like state; or workspace hot write |
| **`needs_input`** | Age-capped pending approval; or main.log state matching WAITING / ASK_USER / NEED_INPUT / … |
| **Gaps** | Conversations DB often terminal-only; stale approvals ignored by age |

### AutoClaw (`autoclaw-1`)

| | |
|--|--|
| **Presence** | `AutoClaw.app/Contents/MacOS/AutoClaw` (HTTP health alone ≠ online) |
| **Primary sources** | `~/.openclaw-autoclaw/` session locks, `task_runs`, gateway log processing/trace, open `chat_turn_*` in dev log; identity bindings JSON |
| **Busy** | `.jsonl.lock`; active task_runs; gateway `processing`; open chat turn (alone/corroborated); short session mtime; request trace; binding busy statuses |
| **`needs_input`** | Binding status in `{waiting,blocked,needs_auth,needs_input}` → mapped to **`needs_input`** (not separate needs_auth) |
| **Gaps** | Bindings can stay `ready` while working — poller uses locks/logs/tasks, not ready-as-idle-only |

### 豆包工作 (`doubao-1`)

| | |
|--|--|
| **Presence** | `DoubaoWork.app/Contents/MacOS/DoubaoWork` only |
| **Primary sources** | `~/Library/Application Support/DoubaoWork/coding/snapshot` (open execution without `endedAtMs`); trajectory `tool_calls` dangling / hot mtime; `agent_infra` activity |
| **Busy** | Open coding execution; dangling/hot trajectory; non-weak agent_infra |
| **`needs_input`** | **Not emitted** by current poller |
| **Gaps** | **`needs_input` weak / absent** — no reliable public wait/approval signal; online + no open work → `idle` |

### Claude Code (`claude-code-1`)

| | |
|--|--|
| **Presence** | Real Claude Code / Claude.app (not Hermes embeds): `@anthropic-ai/claude-code/`, `~/.local/bin/claude`, npm-global, `Claude.app`, or live `/tmp/cc-socks/*.sock` |
| **Primary sources** | Fresh hook file `~/.agent-stage/status/claude-code-1.json` (non-poller source, &lt;180s) → public mirror; else `claude agents --json`; else `~/.claude/projects/**/*.jsonl` mtime &lt;20s |
| **Busy** | Any listed agent session; or hot transcript |
| **`needs_input`** | **Hooks only** (`examples/hooks/claude-status-write.sh` writing the status file). Poller alone does not detect permission prompts |
| **Gaps** | Without hooks: idle summary explicitly says「细等操作需 hooks」 |

### Codex (`codex-1`)

| | |
|--|--|
| **Presence** | Codex CLI / Codex.app / SkyComputerUseService mains in `APP_MAINS` |
| **Primary sources** | Newest `~/.codex/sessions/**/rollout-*.jsonl` (`task_started` without `task_complete`); permission/approval event heuristics; `~/.codex` session mtime |
| **Busy** | Open task in rollout; or session mtime &lt;60s |
| **`needs_input`** | Rollout event types matching permission / approval / elicitation / waiting_for_user (age-capped) |
| **Gaps** | Interactive approval weaker / less documented than Claude hooks; optional stub `codex-hint.mjs` |

---

## Optional standalone bridges

These write the same snapshot protocol; the UI usually consumes via `FileStatusAdapter` / `statusUrl`.

| Script | Target | Mechanism |
|--------|--------|-----------|
| `buddy-jobs-poll.mjs` | WorkBuddy / CodeBuddy | Jobs HTTP (`--serve`); 401/403 → `needs_auth` |
| `hermes-poll.mjs` | Hermes | `GET /api/sessions` + API key |
| `autoclaw-poll.mjs` / `dsh-poll.mjs` / `marv-poll.mjs` | respective | Best-effort CLI/HTTP (coarse vs Mac poller) |
| `grok-official-status-export.mjs` | Grok | Host gateway `listAgents` → drop JSON |
| `codex-hint.mjs` | Codex | Stub / hint only |

Canonical live path for the default roster on a Mac: **`pnpm bridge:live`**.

---

## 中文速查

| Agent | 忙判定要点 | 等操作 | 主要缺口 |
|-------|------------|--------|----------|
| WorkBuddy | DB 自动化 / 心跳 / 会话状态 | PENDING_REVIEW 等 | 无 DB 则粗 |
| CodeBuddy | automations + sessions DB + log | waiting/blocked… | 不扫 :8080 |
| Hermes | gateway busy + leases | kanban / pending 写入 | **内存审批不可见** |
| DSH | 开回合 / 会话热 | 暖会话无开回合 → await-user | 不刮需 cookie 的 web API |
| Grok Bot | listAgents / 官方 drop | awaitingUserResponse | 无 Path A/B 则只显示空闲 |
| Marvis | log / 工作区 | 审批 + waiting 态 | 会话库多为终态 |
| AutoClaw | lock / task / gateway | binding waiting… | ready≠空闲 |
| 豆包 | coding snapshot / 轨迹 | **无** | **needs_input 弱** |
| Claude Code | agents CLI / 转录 | **仅 hooks** | 无 hook 看不到权限等待 |
| Codex | rollout task_started | rollout 权限事件 | 弱于 Claude hooks |
