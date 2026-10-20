# Agent Stage（多 Agent 状态舞台）

> Open-source desktop board that shows what your coding agents are doing — with configurable anime characters, a video-call-style main stage + seats, and pluggable adapters.

中文 / English

## 这是什么 · What

本机常驻窗口，一眼看到各厂商 Agent 是在跑、等授权、等操作，还是完成待审。  
用二次元立绘占位按状态表现；要人介入时上台到主舞台，超时退回坐席并保持呼吸光。

## MVP 计划 · Plan

| Phase | Scope |
|-------|--------|
| M0 | Domain model, stage rules, Mock adapter, RuntimeStore, Tauri 2 shell |
| M1 | Main stage + seat bar UI, promote / demote / timeout glow, debug panel |
| M2 | Settings UI + local persistence (`localStorage` / Tauri `config.json`) |
| M3 | Status ingest protocol + `FileStatusAdapter` |
| **M3.1** (now) | Vendor adapters by **user priority**: WorkBuddy → CodeBuddy → … → Codex; Mac pack |
| M4 | Deeper vendor fidelity + UI polish |

**Status model:** 6 built-in + up to 4 custom (max 10).  
**Attention:** `silent` = idle+running; `attention` = the rest (`done` = awaiting review for MVP).

## 设置与持久化 · Settings

顶部 **设置** 主路径只配 UI：

- 坐席 Agents（名称、启用、坐席 #、绑定角色）
- 背景色 / 图片、超时、坐席侧（bottom / left / right，会真正改布局）
- 坐席卡宽 / 条高；默认卡宽 **112px**，立绘 **2:3**
- **每角色** 一套六态状态图（角色库可多套，Agent 各自绑定）
- 适配器 / Jobs token / 自定义状态在 **高级** 折叠里（默认 12 Agent 已预置）

默认名单：WorkBuddy、CodeBuddy、Hermes、DeepSeek Harness、Grok Bot、Marvis、AutoClaw、豆包工作、Claude Code、Codex、Kimi、智谱清言。  
真实状态能力见 **[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**；Mac 步骤见 **[docs/macos.md](docs/macos.md)**。

保存后立刻应用到舞台，并写入本地：

| 环境 | 存储 |
|------|------|
| Vite / 浏览器 | `localStorage` key `agent-stage-config` |
| Tauri 桌面 | `app_data_dir/config.json`（并镜像到 localStorage） |

实现：`src/config/persist.ts`；Tauri 命令 `load_app_config` / `save_app_config`。

## 状态接入 · Status ingest (M3)

统一协议：写快照 JSON 到 `~/.agent-stage/status/<id>.json`（或配置 `statusUrl`）。  
研究笔记与各厂商 hooks/API 对照见 **[docs/status-ingest.md](docs/status-ingest.md)**。

```bash
# 写一份演示快照（浏览器可用 public/status/demo.json）
pnpm exec tsx scripts/write-status.ts --id demo --status needs_input --summary "approve?" --out public/status/demo.json
```

设置里把某个 Agent 的适配器改成 `file`，`statusUrl` 填 `/status/demo.json`，保存后即可驱动舞台（无需 Start Mock）。

Claude Code 示例 hook：`examples/hooks/claude-status-write.sh`。

## 默认显示尺寸 · Default display

副屏默认 **iPad 4 横屏物理 2048×1536**（见 `src/config/display.ts`；@2x 逻辑 1024×768 仅作说明）。布局跟窗口视口走；请把窗口调到副屏约 2048 宽。可在设置里改 window / seat 数值。坐席间距会自动均分剩余宽度。

## 开发 · Develop

```bash
pnpm install
pnpm dev          # http://localhost:5173 — 点「设置」
pnpm tauri dev
pnpm build
pnpm smoke
pnpm typecheck
```

**Demo M2:** `pnpm dev` → 设置 → 改背景色 / 加减 Agent → 保存并应用 → 刷新页面应保留。

Requires: Node 20+, pnpm 9+, Rust via rustup (≥1.90 for Tauri 2.x).

### Linux Tauri deps

```bash
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf
```

## 目录 · Layout

```
src/
  adapters/      mock + file (StatusSnapshot protocol v1)
  config/        types, display, persist (load/save/merge)
  components/    StageView, SeatBar, AgentCard, SettingsPanel, DebugPanel…
  App.tsx        Shell + settings + file adapter wiring
docs/status-ingest.md   vendor research + ingest protocol
examples/hooks/  Claude Code → snapshot writer
src-tauri/       Tauri 2 + config file commands
.archify/        architecture diagrams (kept)
```

## macOS 迁移 · Mac handoff

完整步骤见 **[docs/macos.md](docs/macos.md)**。

```bash
pnpm pack:mac          # → /workspace/agent-status-board-mac-*.tar.gz (+ zip)
# 拷到 Mac 后：
pnpm install && pnpm smoke && pnpm dev
pnpm tauri:dev
```

前置：Xcode CLT、Node 20+、pnpm、Rust（Tauri）。无 Linux 专用运行时依赖。

## 适配器优先级 · Adapter priority

1 WorkBuddy · 2 CodeBuddy · 3 GLM · 4 AutoClaw · 5 DSH · 6 Marvs · 7 Hermes · 8 Claude Code · 9 Codex  

设置里按此顺序。Jobs API 型（1–2）可直接选；其余多为 bridge → `~/.agent-stage/status/*.json` + file 系适配器。详见 [docs/status-ingest.md](docs/status-ingest.md)。

```bash
pnpm bridge:workbuddy -- --id wb-1 --once
pnpm bridge:codebuddy -- --id cb-1
```

## License

MIT
