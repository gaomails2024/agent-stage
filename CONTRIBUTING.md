# 贡献指南 · Contributing

中文为主。Thank you for contributing to **Agent Stage**.

## 开发环境 · Setup

```bash
pnpm install
pnpm dev          # Vite → http://localhost:5173
pnpm typecheck
pnpm smoke
# 可选桌面壳：
pnpm tauri:dev
```

需要 Node 20+、pnpm 9+。Tauri 另需 Rust。详见 [README.md](README.md)。

## 代码在哪 · Where things live

| 区域 | 路径 | 说明 |
|------|------|------|
| UI / 舞台 / 设置 | `src/`（React + Vite） | 看板、坐席、配置面板、RuntimeStore |
| 适配器 | `src/adapters/` | `FileStatusAdapter`、`BuddyJobsAdapter`、`registry.ts` |
| 配置模型 | `src/config/` | roster、persist、`forceVersion` 导入 |
| Tauri 壳 | `src-tauri/` | 桌面窗 + `config.json` 读写 |
| macOS 直播 poller | `scripts/bridges/macos-live-status-poll.mjs` | 写 `~/.agent-stage/status/` + `public/status/` |
| 其他 bridge | `scripts/bridges/*.mjs` | Jobs / Hermes HTTP / Grok export 等 |
| 协议与信号文档 | `docs/status-ingest.md`、`docs/signals.md`、`docs/LIMITATIONS.md` |
| Demo 快照 | `public/status/*.json` | 安全占位，勿提交真实会话导出 |

**UI 与 poller 解耦：** UI 只读快照 JSON（或 Jobs adapter）；poller / hooks 负责写文件。改 UI 不必改 poller；加厂商信号优先写 bridge → 文件协议。

## 加状态适配器 / Bridge（高层）

1. **统一协议**：写 [StatusSnapshot v1](docs/status-ingest.md) 到 `~/.agent-stage/status/<agentId>.json`（原子 rename）。
2. **最快路径**：继续用 `adapterType: file` + `statusUrl: /status/<id>.json`，在 `scripts/bridges/` 加脚本（可参考 `buddy-jobs-poll.mjs` / poller 内某一 `pollXxx`）。
3. **应用内 adapter**（可选）：在 `src/adapters/` 实现 `AgentAdapter`，于 `registry.ts` 注册；仅当需要浏览器内直连 HTTP（如 Jobs）时才值得。
4. **Mac 直播名单**：若要进默认 poller，在 `macos-live-status-poll.mjs` 的 `APP_MAINS` + `tick()` 增加存在性与忙闲映射；并更新 [docs/signals.md](docs/signals.md) / [LIMITATIONS.md](docs/LIMITATIONS.md)。
5. **Hooks**：Claude 类产品优先用 `examples/hooks/` 写快照，而不是刮 TUI。

不要发明厂商未暴露的「假 live API」。不确定就标 gap，或只做 file-drop。

## 请勿提交

- `node_modules/`、`dist/`、`src-tauri/target/`
- **`.runtime/`**（本地 bridge 运行时输出）
- **本机绝对路径**（`/Users/…`、`/home/box/…`、内网 IP、token、真实会话 JSON）
- AppleDouble / Finder 垃圾：`._*`、`.DS_Store`（已在 `.gitignore`）
- 含个人 `forceVersion` 实验串或私有机器 dump 的 `config.override` —— 公开仓只用通用标记（如 `oss-roster-v1`）

## `forceVersion`（Mac 硬刷新花名册）

`public/config.override.json` 可带 `forceVersion` 字符串。当本地已记录的版本与文件中**不一致**时，应用会**一次性**把 override 合并进 localStorage / Tauri config（见 `src/config/persist.ts`）。

- 改默认坐席 / 角色绑定并希望已有安装刷新：bump `forceVersion`。
- 日常 UI 调色 / 改座位：用户保存后会保留，直到下次 bump。
- 不要用 forceVersion 塞本机 token 或私有路径。

手动重置：清 `localStorage` 的 `agent-stage-config` 与 `agent-stage-force-version` 后刷新。

## 检查与提交

```bash
pnpm typecheck && pnpm smoke
# 改了 poller 逻辑时，对照 docs/signals.md 是否仍准确
```

PR / commit 说明写清：UI、poller、还是文档；涉及信号时链到 `docs/signals.md` 对应 Agent。

## License

贡献内容默认按仓库 [MIT](LICENSE) 授权。
