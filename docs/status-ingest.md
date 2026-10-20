# Agent Stage — Status ingest research & protocol

English summary first; 中文摘要在后。

## User priority order (MOST USED FIRST)

Adapters and bridges are implemented / documented in this order — **not** by technical ease:

| # | Product | Ship status | Mechanism |
|---|---------|-------------|-----------|
| 1 | **WorkBuddy** | ✅ In-app `BuddyJobsAdapter` + `scripts/bridges/buddy-jobs-poll.mjs` | Jobs HTTP (`--serve`) |
| 2 | **CodeBuddy** | ✅ Same adapter (`adapterType: codebuddy`) + same bridge | Jobs HTTP (shared API family) |
| 3 | **GLM** | ✅ File-backed + Claude hook w/ `AGENT_STAGE_VENDOR=glm` | GLM Coding Plan rides Claude Code hooks |
| 4 | **AutoClaw** | ✅ Bridge `autoclaw-poll.mjs` (crew CLI) | Best-effort JSON/text |
| 5 | **DeepSeek Harness (dsh)** | ✅ Coarse bridge `dsh-poll.mjs` | Prefer future DSH plugin on `agent/status` |
| 6 | **Marvs** (Marv / agentmarv) | ✅ Bridge `marv-poll.mjs` | `marv status` heuristics |
| 7 | **Hermes Agent** | ✅ Bridge `hermes-poll.mjs` | `/api/sessions` |
| 8 | **Claude Code** | ✅ `examples/hooks/claude-status-write.sh` | Official hooks → snapshot file |
| 9 | **Codex** | ⚠️ Stub `codex-hint.mjs` | Need `codex exec --json` mapper |

Always keep **`file`** + protocol v1 as the universal backplane.

---

## Goal

Observe live work status for coding agents and map them into Agent Stage’s six built-in states:

`idle | running | needs_auth | needs_input | done | error`

**Strategy:** ship a stable **file/HTTP ingest protocol** first (`FileStatusAdapter`), then add vendor-specific adapters that *write* (or translate) into the same snapshot format. Do not scrape TUI pixels.

---

## Recommended ingest protocol (v1)

### Primary: status snapshot JSON (atomic replace)

Default directory (override with `AGENT_STAGE_HOME`):

```text
~/.agent-stage/status/<agentId>.json
```

Example:

```json
{
  "schemaVersion": 1,
  "agentId": "claude-main",
  "status": "needs_input",
  "summary": "Permission: allow Bash(npm test)?",
  "observedAt": "2026-10-20T02:15:00.000Z",
  "vendor": "claude-code",
  "sessionId": "abc123",
  "meta": { "hook": "PermissionRequest" }
}
```

**Writer rules**

1. Write to a temp file in the same directory, then `rename()` onto `<agentId>.json` (atomic on POSIX).
2. Always set `observedAt` (ISO-8601). Stale snapshots: Stage may treat as `idle` if older than a configured TTL (future).
3. `agentId` in the file should match the roster id in Agent Stage settings (or the adapter remaps it).
4. `status` must be a built-in id or a user-defined custom status id.

### Secondary: NDJSON append log (optional)

```text
~/.agent-stage/events/<agentId>.ndjson
```

Each line:

```json
{"schemaVersion":1,"op":"upsert","agentId":"claude-main","status":"running","summary":"Editing foo.ts","observedAt":"…","vendor":"codex"}
```

`FileStatusAdapter` MVP reads **snapshots only**. An event-tail adapter can come later.

### Tertiary: localhost POST (future)

```http
POST http://127.0.0.1:3927/v1/status
Content-Type: application/json

{ …same snapshot body… }
```

Useful when the Stage UI is browser-only and cannot watch the home directory. Not required for M3 file path.

### Browser demo source

For Vite without Tauri FS, configure `adapterConfig.statusUrl` (e.g. `/status/demo.json` under `public/`). Same JSON schema.

---

## Vendor research (public docs, 2026)

### Claude Code (Anthropic)

| Item | Finding |
|------|---------|
| Official surface | **Yes — Hooks** + session transcripts + CLI helpers |
| Hooks | `PermissionRequest`, `Notification` (`agent_needs_input`, `permission_prompt`, `agent_completed`, …), `Stop` / `StopFailure`, `SessionStart` / `SessionEnd`, tool events |
| Paths | Transcripts: `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl` (or `$CLAUDE_CONFIG_DIR`). Daemon: `~/.claude/daemon.log`. |
| CLI | `claude auth status` (JSON); `claude agents --json` (background sessions); `claude daemon status` |
| Best hook for Stage | Command/HTTP hooks that **write Agent Stage snapshot JSON** on `PermissionRequest` / `Notification` / `Stop` / `StopFailure` / `SessionEnd` |

**State mapping (reliable → fragile)**

| Stage status | Claude Code signal |
|--------------|-------------------|
| `running` | Between `UserPromptSubmit` and `Stop`; tool loop active |
| `needs_input` | `PermissionRequest`; `Notification` matcher `agent_needs_input` / `permission_prompt` / elicitation |
| `needs_auth` | `StopFailure` matcher `authentication_failed` / `oauth_org_not_allowed` / `cloud_credential_error`; `claude auth status` not logged in |
| `done` | `Stop` (turn finished) — treat as “awaiting review” if desired |
| `error` | `StopFailure`, `PostToolUseFailure` (optional), daemon crash |
| `idle` | `SessionEnd` or long quiet after `Stop` |

**Difficulty:** **Low–medium** if using hooks → file protocol. **High** if only tailing JSONL transcripts (async lag, format churn).

---

### OpenAI Codex CLI

| Item | Finding |
|------|---------|
| Official surface | **Partial** — `codex exec --json` JSONL events; on-disk rollouts under `~/.codex/sessions` (not a stable public “status API”) |
| Live events | `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error` |
| Auth | `~/.codex/auth.json`; env `CODEX_API_KEY` for automation |
| Interactive TUI | No documented status HTTP for the interactive session |

**State mapping**

| Stage | Codex signal |
|-------|----------------|
| `running` | After `turn.started` until terminal turn event |
| `done` | `turn.completed` without error |
| `error` | `turn.failed` / `error` / complete-with-error |
| `needs_input` | Approval / sandbox prompts — **weakly documented** for interactive mode; better via wrapping or App Server if enabled |
| `needs_auth` | Auth failure / missing credentials |
| `idle` | No active turn / process exited |

**Difficulty:** **Medium** for `codex exec --json` pipelines (translate events → snapshot). **High** for interactive TUI (parse rollout JSONL; format may change — version the adapter).

---

### DeepSeek Harness (`dsh`)

| Item | Finding |
|------|---------|
| Official surface | **Yes — rich event system** |
| Control plane | In-process Cordis: `agent/status`, `agent/created`, `agent/disposed`, `agent/request-error`, … |
| Session log | Append-only under `~/.dsh/sessions/*/*/session*.jsonl.zstd` (zstd); types like `turn/start`, `turn/end`, `tool/call`, `user/message` |
| Headless | `dsh --profile headless --json "task"` → NDJSON run events on stdout |
| Live status | Agent `running` / `idle` (also used by community plugins like session-doctor) |

**State mapping**

| Stage | DSH signal |
|-------|------------|
| `running` / `idle` | Directly from `agent/status` |
| `error` | `agent/request-error`, `agent/error` |
| `needs_input` | Permission / inbox wait events if present in profile |
| `done` | Turn end with success / session dispose |
| `needs_auth` | LLM auth failures in request-error path |

**Difficulty:** **Medium**. Best path: DSH plugin that listens to `agent/status` and writes Stage snapshots; or poll/decompress session logs (fragile + CPU). Headless `--json` is clean for scripted runs.

---

### Hermes Agent (NousResearch)

| Item | Finding |
|------|---------|
| Official surface | **Yes — HTTP API server** (OpenAI-compatible + sessions API) |
| Storage | CLI sessions in `~/.hermes/state.db` |
| API | `GET /api/sessions`, `POST …/chat/stream` (SSE: `tool.started`, `run.completed` / `run.failed` / `run.cancelled`); gated by `API_SERVER_KEY` |
| CLI | `/status`, `hermes sessions list`, resume flags |

**State mapping**

| Stage | Hermes signal |
|-------|----------------|
| `running` | Active run / `tool.started` without terminal run event |
| `done` | `run.completed` |
| `error` | `run.failed` |
| `idle` | No active run; session list idle |
| `needs_input` / `needs_auth` | Depends on gateway features; probe `/v1/capabilities` |

**Difficulty:** **Low–medium** if API server is running (poll sessions or watch SSE). **Medium** if only SQLite (schema may change; need read-only queries).

---

### CodeBuddy / WorkBuddy

| Item | Finding |
|------|---------|
| Official surface | **CodeBuddy Code CLI HTTP API (Beta)** — `codebuddy --serve --port 8080` |
| Jobs | `GET /api/v1/jobs`, `GET /api/v1/jobs/events` (SSE). Job `state`: `working` \| `blocked` \| `done` \| `failed` \| `stopped`; `status`: `busy` \| `waiting` \| `idle` \| `stopped` |
| Auth | `GET /api/v1/auth/status` |
| VS Code extension | No clear public “status socket” documented separately from CLI serve |

**State mapping**

| Stage | Jobs API |
|-------|----------|
| `running` | `working` / `busy` |
| `needs_input` | `blocked` / `waiting` |
| `done` | `done` |
| `error` | `failed` |
| `idle` | `idle` / `stopped` |
| `needs_auth` | auth status endpoint |

**Difficulty:** **Low** when `--serve` is on (almost 1:1). Extension-only installs without serve: **high / unknown**.

---

### Generic patterns

| Pattern | Use when | Fragility |
|---------|----------|-----------|
| **Hooks → Stage JSON** | Vendor has lifecycle hooks (Claude) | Low |
| **CLI `--json` / NDJSON** | Headless/CI (Codex exec, dsh headless) | Low–medium |
| **Local HTTP / SSE** | Hermes, CodeBuddy serve | Low |
| **Session JSONL / DB tail** | No better API | High (format drift, lag, multi-session) |
| **tmux pane title / OSC** | Last resort | Very high |
| **MCP custom tool** | Agent can call “report_status” | Medium (requires agent cooperation) |

---

## Adapter roadmap for Agent Stage

Follow **user priority** (WorkBuddy → … → Codex), not ease.

| Order | Adapter / bridge | Mechanism |
|-------|------------------|-----------|
| Backplane | `file` (`FileStatusAdapter`) | Poll snapshot JSON / `statusUrl` |
| 1–2 | `workbuddy` / `codebuddy` (`BuddyJobsAdapter`) | `GET /api/v1/jobs` (+ bridge script) |
| 3 | `glm` | Same as Claude hooks, `AGENT_STAGE_VENDOR=glm` |
| 4 | `autoclaw` bridge | `crew … --json` |
| 5 | `dsh` bridge | Session mtime heuristic; plugin TODO |
| 6 | `marvs` bridge | `marv status` |
| 7 | `hermes` bridge | Sessions REST |
| 8 | `claude-code` hook | `examples/hooks/claude-status-write.sh` |
| 9 | `codex` stub | Implement JSONL turn mapper next |
| Later | localhost POST ingest / auto-discovery | Optional |

**Mac handoff default:** WorkBuddy/CodeBuddy Jobs adapter or buddy bridge → file; Claude/GLM hooks for permission states.

---

## Known live gaps (Mac poller)

These are product/signal limits observed in `scripts/bridges/macos-live-status-poll.mjs`,
not protocol bugs. Details: [LIMITATIONS.md](./LIMITATIONS.md).

| Product | Gap |
|---------|-----|
| Hermes | In-memory gateway approvals / live “waiting” not on control socket |
| Claude Code | Permission / needs_input without hooks → invisible |
| 豆包工作 | `needs_input` not emitted by current poller |
| Codex | Interactive approval weaker than Claude hooks |

Ship hooks / file drops when fine wait states matter.

---

## 中文摘要

- **用户优先级**：WorkBuddy → CodeBuddy → GLM → AutoClaw → DSH → Marvs → Hermes → Claude Code → Codex。
- **统一协议**：`~/.agent-stage/status/<id>.json`；浏览器可用 `statusUrl`。
- **WorkBuddy/CodeBuddy**：同一套 Jobs HTTP（`--serve`），应用内 `BuddyJobsAdapter` + `buddy-jobs-poll.mjs`。
- **GLM**：走 Claude Code Hooks，设 `AGENT_STAGE_VENDOR=glm`。
- **其余**：bridge 脚本写快照；Codex 仍为 stub。
- 详见设置里的适配器下拉与 `docs/macos.md`。

See also: `src/adapters/registry.ts`, `src/adapters/buddyJobs.ts`, `scripts/bridges/`.
