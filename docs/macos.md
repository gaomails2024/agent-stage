# macOS runbook · Agent Stage

Target: Apple Silicon (arm64) or Intel Mac.

## Prerequisites

1. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```
2. **Node.js 20+** (Homebrew recommended)
   ```bash
   brew install node@20
   node -v   # >= 20
   ```
3. **pnpm 9+**
   ```bash
   corepack enable && corepack prepare pnpm@9 --activate
   ```
4. **Rust** (optional, for Tauri desktop window)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
5. **sqlite3** + **curl** (for the live Mac poller) — usually preinstalled.

## Clone & run

```bash
git clone https://github.com/gaomails2024/agent-stage.git
cd agent-stage
pnpm install
pnpm typecheck
pnpm smoke
pnpm dev
# optional: pnpm tauri:dev
```

Or from a pack archive:

```bash
tar -xzf agent-stage-mac-*.tar.gz
cd agent-stage-mac-*   # folder name includes timestamp
pnpm install && pnpm smoke && pnpm dev
```

First load may import the roster from `public/config.override.json` when
`forceVersion` bumps (see [LIMITATIONS.md](./LIMITATIONS.md)). Settings UI is for
status images, seat side/order, colors, background — not for inventing vendor APIs.

### Historical note (dev packs)

Older internal drop archives were named `agent-status-board-mac-*`. Current
`pnpm pack:mac` writes `agent-stage-mac-*.tar.gz` next to the repo (override with
`PACK_OUT_DIR`). Nested paths like `/workspace/agent-status-board/` in old
architecture receipts were sanitized for the public tree.

## Live status (recommended)

In a second terminal:

```bash
pnpm bridge:live
# or: node scripts/bridges/macos-live-status-poll.mjs
# one shot: pnpm bridge:live:once
```

Then hard-refresh the Vite page. Seat cards leave stub idle as real signals
arrive. Fidelity and gaps: [LIMITATIONS.md](./LIMITATIONS.md). Signal sources: [signals.md](./signals.md).

### How the poller works (high level)

1. **Presence** — match a whitelist of real app/CLI main binaries in `ps` output.
2. **Work signals** — per product: SQLite / session JSONL / logs / optional HTTP
   (WorkBuddy DB, Hermes gateway state, Claude `agents --json`, Codex rollouts, …).
3. **Write** — atomic JSON snapshots to `~/.agent-stage/status/<id>.json` and mirror
   into `<repo>/public/status/` for the browser File adapter.

The poller is **macOS-oriented**. It will not magically read Windows/Linux app
layouts. Without local agent apps installed, seats stay offline/idle stubs.

### WorkBuddy note

Live interactive work is detected from `~/.workbuddy/sessions/*.json` heartbeats
(not only SQLite `sessions.status`). Stale cancelled `PENDING_REVIEW` rows are
ignored so the seat does not stick on「等操作」while a session is working.

### Grok Bot

Prefer Path A: set `GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN`, or
`~/.agent-stage/grok-gateway.json`. Optional `GROK_CODER_AGENT_ID` to pin an agent
id; otherwise the poller looks for name `Coder`.

Path B: write `~/.agent-stage/status/grok-bot.json` (schema v1); the poller mirrors
it to `grok-bot-1` when fresh. See `scripts/bridges/grok-official-bridge-README.md`.

### Claude / Doubao / Hermes gaps

- **Claude Code:** fine `needs_input` needs hooks (`examples/hooks/claude-status-write.sh`).
- **豆包工作:** running detection is relatively good; `needs_input` is weak/absent.
- **Hermes:** busy via gateway/leases is solid; in-memory wait/approval is not on the socket.

## Jobs API (optional fine path)

```bash
# Example — only if your CodeBuddy/WorkBuddy install exposes Jobs serve:
codebuddy --serve --port <port>
# Settings → 高级 → authToken, or:
CODEBUDDY_TOKEN=... node scripts/bridges/buddy-jobs-poll.mjs --vendor codebuddy --id codebuddy-1
```

## Claude / GLM hooks

```bash
chmod +x examples/hooks/claude-status-write.sh
# Point Claude Code hooks at the absolute path; for GLM-style reuse:
#   AGENT_STAGE_ID=glm-1 AGENT_STAGE_VENDOR=glm
```

## Verify

```bash
pnpm typecheck && pnpm smoke && pnpm build
```

## pnpm on locked-down Macs

This repo ships `.npmrc` (`minimum-release-age=0`) and `pnpm-workspace.yaml`
(`allowBuilds.esbuild: true`). If install still fails:

```bash
pnpm install --config.minimumReleaseAge=0
```

## Notes

- Default seat card width **~112–130px**, portrait **2:3**; seat side **bottom / left / right** reflows layout (no free drag).
- App UI code has no Linux-only runtime deps; live bridges do.
- Do not commit `node_modules/`, `src-tauri/target/`, `dist/`, or `.runtime/`.
