# macOS runbook · Agent Stage

Target: Apple Silicon (arm64) or Intel Mac. Asia/Shanghai timezone optional.

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

## Unpack & run

```bash
cd ~/Projects   # or wherever you like
tar -xzf agent-status-board-mac-*.tar.gz
cd agent-status-board-*   # folder name includes timestamp

pnpm install
pnpm typecheck
pnpm smoke
pnpm exec vite --host 127.0.0.1 --port 5174   # if 5173 busy
# or: pnpm dev
# optional: pnpm tauri:dev
```

First load after this pack imports the **12-agent** roster via
`public/config.override.json` (`forceVersion`). Settings are UI-only:
status images, seat side/order, colors, background.

## Live status (recommended)

In a second terminal:

```bash
node scripts/bridges/macos-live-status-poll.mjs
```

Then hard-refresh the Vite page. Seat cards should leave stub idle as real
signals arrive. See [LIMITATIONS.md](./LIMITATIONS.md) for per-agent fidelity.

### WorkBuddy note

Live interactive work is detected from `~/.workbuddy/sessions/*.json` heartbeats
(not only SQLite `sessions.status`). Stale cancelled `PENDING_REVIEW` rows are
ignored so the seat does not stick on「等操作」while a session is working.

### Grok Bot

Write `~/.agent-stage/status/grok-bot.json` (schema v1) while the bot is working;
the poller mirrors it to `grok-bot-1`.

## Jobs API (optional fine path)

```bash
codebuddy --serve --port 8080
# put password in Settings → 高级 → authToken, adapter CodeBuddy
# or:
CODEBUDDY_TOKEN=... node scripts/bridges/buddy-jobs-poll.mjs --vendor codebuddy --id codebuddy-1
```

## Claude / GLM hooks

```bash
chmod +x examples/hooks/claude-status-write.sh
# Point Claude Code hooks at the absolute path; for GLM:
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

- Default seat card width **112px**, portrait **2:3**; seat side **bottom / left / right** actually reflows the layout (no free drag).
- App code has no Linux-only runtime deps.
- Do not commit `node_modules/`, `src-tauri/target/`, or `dist/`.
