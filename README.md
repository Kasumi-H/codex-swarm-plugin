# Codex Swarm (`codex-swarm`) — Cross-Platform Antigravity Plugin (macOS / Linux / Windows)

将 Antigravity 主 Agent（如 Neon / Argon / Claude）作为 **统筹大脑（Coordinator）**，将本机安装的 **OpenAI Codex CLI** 作为 **执行子 Agent 集群（Workers & Verifier）**，自带右侧可视化实时看板、关系拓扑图、模型与 6 档推理思考强度配置中心，以及 `@worker ⇄ @verifier` 全自动互审打回闭环。

> **跨平台免 PowerShell**：默认执行引擎已全面统一为跨平台 Node.js (`codex-worker.mjs`)，在**未安装 PowerShell 的 macOS Antigravity 桌面端**上可直接一键安装并稳定运行，同时保持原有 Windows（含 WSL）兼容性不退化。

---

## 一键部署（支持 macOS / Linux / Windows）

### 前置依赖（macOS 独立部署）
1. **Node.js v18+**（推荐通过 `brew install node`、nvm、Volta 或 [nodejs.org](https://nodejs.org/) 安装，无需安装 PowerShell）。
2. **OpenAI Codex CLI**（已安装并完成登录，例如 `codex login`）：
   - 支持 `npm i -g @openai/codex`、`brew install --cask codex` / `brew install codex`；
   - 也支持自动识别 VS Code、Cursor、Antigravity 中已安装的 OpenAI Codex 扩展内置二进制（Apple Silicon `darwin-arm64` 与 Intel `darwin-x86_64` 均支持）。

### macOS / Linux 一键安装
```bash
bash install.sh
# 或者直接运行：
node install.mjs
```
- 支持预览模式：`bash install.sh --dry-run`（仅打印安装计划，不写入文件）。
- 可用 `node install.mjs --data-dir "/path/to/swarm-data"` 指定看板、Worker 和 MCP 共用的数据目录。再次安装时会沿用上次选定的目录。修改目录后需重新加载插件进程。
- 安装脚本会自动将插件复制到 `~/.gemini/config/plugins/codex-swarm`，并在已安装的 `mcp_config.json` 与 `sidecar.json` 中写入当前解析到的 `node` 绝对路径及增强 `PATH`，避免 macOS 桌面应用因 GUI 最小环境变量导致找不到 `node` 或 `codex`。

### Windows 一键安装
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 或者直接运行：
node install.mjs
```

---

## 核心功能

1. **`/codex-swarm` 按需唤出**：平时普通对话不劫持；仅在聊天框输入 `/codex-swarm` 时进入统筹模式，大幅节省 Antigravity (Neon) 额度。
2. **右侧可视化面板（`概览 | 看板 | 成员 | 关系图 | 子Agent配置`）**：
   - 自动拉取本机 Codex 最新实时模型目录（`gpt-6.2-sol`、`gpt-6.2-astra`、`gpt-6.1-terra` 等）与 `low` ~ `ultra` 6 档推理思考强度；
   - 支持配置全局默认 Worker / Verifier 模型及自定义角色预设（`@architect`、`@coder`、`@fast-worker`、`@verifier`），改动即自动保存。
3. **`@worker ⇄ @verifier` 全自动互审与打回重修闭环**：
   - Worker 完成后自动在后台唤醒 `@verifier` 核验；若检出 `[REWORK]` 自动打回给 Worker 修复并复验（全程 0 Neon 额度消耗），直到 `[PASS]` 再向主脑交差。
   - 支持 `-WithArchitect` 先由 `@architect`（只读）输出架构蓝图，再自动交接给执行 Worker。
4. **`--ephemeral` 无痕防污染**：默认开启无痕模式，子 Agent 任务不会弄乱你 Codex 桌面版左侧历史会话列表。
5. **跨平台统一执行引擎 (`codex-worker.mjs`)**：
   - 原生支持 macOS（Apple Silicon / Intel）、Linux、Windows 原生与 Windows WSL；Windows 上仍保留 `codex-worker.ps1` 作为兼容备选。
   - WSL 使用系统默认发行版。工作目录为 `\\wsl.localhost\Debian\...` 或 `\\wsl$\Debian\...` 时，Worker 使用路径中的发行版。

---

## macOS 常见问题（FAQ）

1. **提示找不到 `node` 或 MCP / Sidecar 启动失败（`ENOENT`）**
   - macOS 桌面应用默认仅继承 `/usr/bin:/bin:/usr/sbin:/sbin`。请通过终端重新运行一次 `bash install.sh`，安装脚本会自动探测 Homebrew（`/opt/homebrew/bin`、`/usr/local/bin`）、nvm、Volta、fnm、asdf、mise 等路径并将 `node` 绝对路径写入已安装的 `mcp_config.json` 与 `sidecar.json`。
2. **提示找不到 `codex` 或模型列表未刷新**
   - 在终端运行环境自检，确认识别到的 `node` 和 `codex` 路径：
     ```bash
     node ~/.gemini/config/plugins/codex-swarm/skills/codex-swarm/scripts/codex-worker.mjs --check
     codex debug models
     ```
   - 如尚未安装全局 CLI，可执行 `npm i -g @openai/codex` 并运行 `codex login`。
3. **Antigravity 安装后未显示右侧 Codex Swarm 面板**
   - 确认 `~/.gemini/config/plugins/codex-swarm/sidecars/codex_board/sidecar.json` 与 `mcp_config.json` 已生成，随后重启 Antigravity 桌面端并在右侧 Plugins 栏点击 **Codex Swarm**。
