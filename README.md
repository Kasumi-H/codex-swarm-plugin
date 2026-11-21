# Codex Swarm (`codex-swarm`) — Cross-Platform Antigravity Plugin (macOS & Windows)

将 Antigravity 主 Agent（如 Neon / Argon / Claude）作为 **统筹大脑（Coordinator）**，将本机安装的 **OpenAI Codex CLI** 作为 **执行子 Agent 集群（Workers & Verifier）**，自带右侧可视化实时看板、关系拓扑图、模型与 6 档推理思考强度配置中心，以及 `@worker ⇄ @verifier` 全自动互审打回闭环。

---

## 一键部署（支持 macOS / Windows / Linux）

把本项目文件夹复制到任意电脑（Mac 或 Windows）后，只需一行命令即可完成部署：

### macOS / Linux 一键安装
```bash
bash install.sh
# 或者直接运行：
node install.mjs
```

### Windows 一键安装
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 或者直接运行：
node install.mjs
```

> **前置条件**：
> 1. 已安装 Node.js（v18+）；
> 2. 已安装并登录 OpenAI Codex CLI（无论是通过 `npm i -g @openai/codex`、`brew`、还是 VS Code / Cursor 的 OpenAI Codex 扩展内置二进制，插件都会在 macOS 与 Windows 上自动寻址）。

---

## 核心功能

1. **`/codex-swarm` 按需唤出**：平时普通对话不劫持；仅在聊天框输入 `/codex-swarm` 时进入统筹模式，大幅节省 Antigravity (Neon) 额度。
2. **右侧可视化面板（`概览 | 看板 | 成员 | 关系图 | 子Agent配置`）**：
   - 自动拉取本机 Codex 最新实时模型目录（`gpt-6.2-sol`、`gpt-6.2-astra`、`gpt-6.1-terra` 等）与 `low` ~ `ultra` 6 档推理思考强度；
   - 支持配置全局默认 Worker / Verifier 模型及自定义角色预设（`@architect`、`@coder`、`@fast-worker`、`@verifier`），改动即自动保存。
3. **`@worker ⇄ @verifier` 全自动互审与打回重修闭环**：
   - Worker 完成后自动在后台唤醒 `@verifier` 核验；若检出 `[REWORK]` 自动打回给 Worker 修复并复验（全程 0 Neon 额度消耗），直到 `[PASS]` 再向主脑交差。
4. **`--ephemeral` 无痕防污染**：默认开启无痕模式，子 Agent 任务不会弄乱你 Codex 桌面版左侧历史会话列表。
5. **跨平台执行引擎 (`codex-worker.mjs` & `codex-worker.ps1`)**：
   - 原生支持 macOS（Apple Silicon / Intel）、Windows 原生、以及 Windows WSL Ubuntu。
