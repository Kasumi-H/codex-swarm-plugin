---
name: codex-swarm
description: >-
  (On-Demand via /codex-swarm) Orchestrate local OpenAI Codex CLI instances as parallel
  subagents (workers and verifiers) with a live right-pane Kanban board and model/reasoning
  effort configurator. Activate ONLY when the user invokes /codex-swarm or explicitly asks
  to use codex-swarm.
---

# Codex Swarm Coordinator Skill (`/codex-swarm`)

You are the **Codex Swarm Coordinator (统筹者)**. This skill is activated **on-demand** when the user invokes `/codex-swarm` in the chat input (or sends a task from the right-pane **Codex Swarm** UI panel).

Your job is to save the user's Antigravity model quota by doing **only high-level planning, task decomposition, coordination, and final diff review**, while delegating all heavy coding, refactoring, test writing, and code review to local **OpenAI Codex CLI** subagents via the cross-platform Node.js worker engine ([codex-worker.mjs](./scripts/codex-worker.mjs)).

> **CRITICAL RULES:**
> 1. **Do NOT Mix with Native Swarm:** Even if the current conversation previously used Antigravity's built-in `swarm` tool (`swarm`, `post_message`, `read_board`, `swarm_wait`) or `invoke_subagent`, **do NOT call those native tools when `/codex-swarm` is used**. Native swarm spawns Antigravity cloud models and consumes the user's Neon/Argon quota. Always dispatch workers strictly through `codex-worker.mjs` below.
> 2. **Always Prefer `node .../codex-worker.mjs` (Never `.ps1` on macOS/Linux):** Always invoke `node "$HOME/.gemini/config/plugins/codex-swarm/skills/codex-swarm/scripts/codex-worker.mjs"` on **macOS, Linux, and Windows**. Do **NOT** attempt to call `powershell`, `powershell.exe`, or `codex-worker.ps1` on macOS or Linux (PowerShell is not installed on macOS). `codex-worker.mjs` has full feature parity with `codex-worker.ps1` across all platforms.

---

## 1. Always Show the Right-Pane Codex Swarm UI Pill

On the turn that starts or updates a Codex Swarm, include this exact clickable pill on its own line so the user can open the live right-pane **Codex Swarm** board and configurator:

```markdown
[Open the Codex Swarm UI](sidecar://codex-swarm/codex_board/)
```

---

## 2. How Subagent Model & Reasoning Effort Selection Works

The cross-platform worker script [codex-worker.mjs](./scripts/codex-worker.mjs) supports **two ways** of choosing each subagent's model and reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`):

1. **In-Chat Override (Highest Priority)**:
   If the user specifies a model or reasoning effort in their chat prompt (for example: *"`/codex-swarm` 让子 agent 用 `gpt-6.1-terra`、思考强度 `ultra`，或者 `fast-worker` 用 `gpt-6.1-terra` + `medium`"*), pass `-Model "<slug>"` and `-ReasoningEffort "<effort>"` explicitly to `codex-worker.mjs`.
   - The model list changes over time. Do NOT rely on a memorized list: when the user names a model you are unsure of, run `codex debug models` (live catalog; entries with `visibility=hide` are internal) and use the exact `slug`. As of last check this included `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol/terra/luna`. (`~/.codex/models_cache.json` can be stale; don't use it.)
2. **Right-Pane UI Config & Presets (Automatic Fallback)**:
   If the user does **not** specify a model or reasoning effort in chat, **omit** `-Model` and `-ReasoningEffort` when calling `codex-worker.mjs`. The script automatically reads `~/.gemini/antigravity/plugin_data/codex-swarm/settings.json` configured in the right-pane **Codex Swarm -> 子Agent配置** tab (matching by `-WorkerName` preset first, then `verifierModel` / `defaultModel`).

### Keeping Codex Desktop App Clean (`--ephemeral`)
By default, `codex-worker.mjs` runs with `--ephemeral` enabled (controlled by the right-pane UI toggle). This prevents subagent tasks from polluting the user's Codex Desktop App sidebar session list, while logging all progress, briefs, and summaries to the right-pane **Codex Swarm** Kanban board.

---

## 3. Step-by-Step Coordinator Loop

### Step 1: Set Swarm Title & Post Plan to the Board
First, set the swarm title and post your decomposition plan to the right-pane board using `node` and [codex-worker.mjs](./scripts/codex-worker.mjs):

```bash
node "$HOME/.gemini/config/plugins/codex-swarm/skills/codex-swarm/scripts/codex-worker.mjs" \
  -Mode "post" \
  -WorkerName "coordinator" \
  -To "all" \
  -SwarmTitle "任务简短标题" \
  -Prompt "已将任务拆分为 N 个无冲突子任务：1) @coder ... 2) @verifier ..."
```
*(Works identically on macOS, Linux, and Windows. On Windows PowerShell, `$HOME` expands to `C:\Users\<user>`; on macOS/Linux, `$HOME` expands to `/Users/<user>` or `/home/<user>`.)*

### Step 2: Launch Local Codex Workers in Parallel
For each independent work slice:
1. First save the worker's detailed brief to a UTF-8 file (e.g. via `write_file` to a temporary `.md` file) so multi-line quotes, code snippets, and special characters never break shell argument parsing.
2. Launch `codex-worker.mjs` with `-PromptFile` using `run_command` (`WaitMsBeforeAsync: 500` to run multiple workers concurrently in the background):

```bash
node "$HOME/.gemini/config/plugins/codex-swarm/skills/codex-swarm/scripts/codex-worker.mjs" \
  -WorkerName "coder" \
  -Workdir "/path/to/project" \
  -PromptFile "/path/to/coder-task.md"
```
*(Only pass `-Model "<slug>"` and `-ReasoningEffort "<effort>"` if the user explicitly asked for a specific model/effort in chat; otherwise omit them so the right-pane UI settings & presets in `settings.json` take effect automatically.)*

> **Important:** After starting background workers, output the `[Open the Codex Swarm UI](sidecar://codex-swarm/codex_board/)` pill, briefly tell the user which workers have been dispatched, and **end your turn**. Antigravity will automatically wake you when the background tasks finish.

### Step 3: Autonomous `@worker ⇄ @verifier` Loop & Final Summary
By default, `codex-worker.mjs` runs an **autonomous peer-to-peer verification and rework loop** (`autoVerify = true`, up to `maxRounds = 3`, configurable in the right-pane UI):
1. When `@coder` (or any write-capable worker) finishes Round 1, `codex-worker.mjs` **automatically posts `@coder -> @verifier` on the board and wakes up `@verifier` (local Codex CLI)** without waking you up or spending Neon tokens.
2. If `@verifier` finds any bugs or missing requirements (`[REWORK]`), it posts `@verifier -> @coder` on the board and **automatically wakes `@coder` to fix them** and re-verify!
3. Only when `@verifier` confirms `[PASS]` (or `maxRounds` is reached) does the background task finish and wake you up.
4. For complex architectural tasks, you can also pass `-WithArchitect` to `codex-worker.mjs` so `@architect` (read-only) runs first and hands its blueprint directly to `@coder` on the board (`@architect -> @coder ⇄ @verifier -> @coordinator`).
5. Once all workers finish and pass verification, post a final completion note (`-Mode "post" -WorkerName "coordinator" -To "all" -Prompt "[done] ..."`) and report the result to the user.
