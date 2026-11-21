#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_SCRIPT_MJS = path.resolve(
  __dirname,
  "..",
  "skills",
  "codex-swarm",
  "scripts",
  "codex-worker.mjs"
);
const WORKER_SCRIPT = WORKER_SCRIPT_MJS;
const OUT_DIR = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "codex-swarm");

const TOOLS = [
  {
    name: "codex_worker_exec",
    description:
      "Delegate a coding, refactoring, testing, or debugging task to a local OpenAI Codex CLI subagent (Windows or WSL). Saves Antigravity quota by letting local Codex execute the task.",
    inputSchema: {
      type: "object",
      properties: {
        worker_name: {
          type: "string",
          description: "Short identifier for this worker (e.g. 'backend-api', 'ui-worker', 'tests')."
        },
        workdir: {
          type: "string",
          description: "Absolute working directory path (Windows path like C:\\... or WSL path like \\\\wsl$\\Ubuntu\\... or /home/kasumi/...)."
        },
        prompt: {
          type: "string",
          description: "Self-contained brief specifying Goal, Owned Files, Context, and Definition of Done."
        },
        sandbox: {
          type: "string",
          enum: ["workspace-write", "read-only", "danger-full-access"],
          description: "Sandbox policy for Codex shell commands (default: 'workspace-write')."
        },
        full_access: {
          type: "boolean",
          description: "If true, passes --dangerously-bypass-approvals-and-sandbox for unrestricted local execution."
        },
        worktree: {
          type: "boolean",
          description: "If true, runs Codex in an isolated managed Git worktree (--worktree)."
        },
        use_wsl: {
          type: "boolean",
          description: "Force execution via WSL Ubuntu (/home/kasumi/.local/bin/codex)."
        },
        model: {
          type: "string",
          description: "Optional model override (defaults to user's ~/.codex/config.toml model)."
        }
      },
      required: ["worker_name", "workdir", "prompt"]
    }
  },
  {
    name: "codex_worker_review",
    description:
      "Run a non-interactive local Codex Verifier (code review) on uncommitted changes, a branch, or a commit.",
    inputSchema: {
      type: "object",
      properties: {
        worker_name: {
          type: "string",
          description: "Verifier name (default: 'verifier')."
        },
        workdir: {
          type: "string",
          description: "Absolute path to the Git repository."
        },
        prompt: {
          type: "string",
          description: "Optional custom review instructions."
        },
        uncommitted: {
          type: "boolean",
          description: "Review staged, unstaged, and untracked changes (default: true)."
        },
        base_branch: {
          type: "string",
          description: "Optional base branch to diff against."
        },
        commit_sha: {
          type: "string",
          description: "Optional commit SHA to review."
        },
        use_wsl: {
          type: "boolean",
          description: "Force execution via WSL Ubuntu."
        }
      },
      required: ["workdir"]
    }
  },
  {
    name: "codex_worker_resume",
    description:
      "Send follow-up or rework instructions to the most recent (or a specific) local Codex worker session.",
    inputSchema: {
      type: "object",
      properties: {
        worker_name: {
          type: "string",
          description: "Worker name for logging."
        },
        workdir: {
          type: "string",
          description: "Working directory of the session."
        },
        prompt: {
          type: "string",
          description: "Follow-up instructions for the worker."
        },
        session_id: {
          type: "string",
          description: "Optional session UUID or thread name. Omit to resume the most recent session (--last)."
        },
        fork: {
          type: "boolean",
          description: "If true, forks the session into a new branch thread instead of resuming in-place."
        },
        full_access: {
          type: "boolean",
          description: "If true, bypasses approvals and sandboxing."
        },
        use_wsl: {
          type: "boolean",
          description: "Force execution via WSL Ubuntu."
        }
      },
      required: ["workdir", "prompt"]
    }
  },
  {
    name: "codex_swarm_status",
    description:
      "Check local Codex CLI binaries (Windows & WSL), ~/.codex/config.toml settings, and recent Codex Swarm worker summary reports.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

function runPowerShellWorker(psArgs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WORKER_SCRIPT_MJS, ...psArgs],
      {
        windowsHide: true,
        env: { ...process.env }
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: String(err) });
    });
  });
}

async function handleToolCall(name, args = {}) {
  if (name === "codex_swarm_status") {
    const home = os.homedir();
    const configTomlPath = path.join(home, ".codex", "config.toml");
    const configToml = fs.existsSync(configTomlPath)
      ? fs.readFileSync(configTomlPath, "utf8")
      : "(not found)";
    let summaries = [];
    if (fs.existsSync(OUT_DIR)) {
      summaries = fs
        .readdirSync(OUT_DIR)
        .filter((f) => f.endsWith("-summary.md"))
        .map((f) => {
          const full = path.join(OUT_DIR, f);
          const stat = fs.statSync(full);
          return `${f} (updated ${stat.mtime.toISOString()})`;
        });
    }
    return {
      content: [
        {
          type: "text",
          text: [
            `Worker Script: ${WORKER_SCRIPT}`,
            `Output Directory: ${OUT_DIR}`,
            `Recent Worker Summaries:\n${summaries.length ? summaries.join("\n") : "(none yet)"}`,
            `\n~/.codex/config.toml:\n${configToml}`
          ].join("\n")
        }
      ]
    };
  }

  if (name === "codex_worker_exec") {
    const psArgs = [
      "-Mode",
      "exec",
      "-WorkerName",
      String(args.worker_name || "worker"),
      "-Workdir",
      String(args.workdir || process.cwd()),
      "-Prompt",
      String(args.prompt || ""),
      "-Sandbox",
      String(args.sandbox || "workspace-write")
    ];
    if (args.full_access) psArgs.push("-FullAccess");
    if (args.worktree) psArgs.push("-Worktree");
    if (args.use_wsl) psArgs.push("-UseWsl");
    if (args.model) psArgs.push("-Model", String(args.model));

    const res = await runPowerShellWorker(psArgs);
    return {
      isError: res.code !== 0,
      content: [
        {
          type: "text",
          text: `${res.stdout}\n${res.stderr ? "\n[STDERR]\n" + res.stderr : ""}`.trim()
        }
      ]
    };
  }

  if (name === "codex_worker_review") {
    const psArgs = [
      "-Mode",
      "review",
      "-WorkerName",
      String(args.worker_name || "verifier"),
      "-Workdir",
      String(args.workdir || process.cwd())
    ];
    if (args.prompt) psArgs.push("-Prompt", String(args.prompt));
    if (args.uncommitted !== false && !args.base_branch && !args.commit_sha) {
      psArgs.push("-Uncommitted");
    }
    if (args.base_branch) psArgs.push("-BaseBranch", String(args.base_branch));
    if (args.commit_sha) psArgs.push("-CommitSha", String(args.commit_sha));
    if (args.use_wsl) psArgs.push("-UseWsl");

    const res = await runPowerShellWorker(psArgs);
    return {
      isError: res.code !== 0,
      content: [
        {
          type: "text",
          text: `${res.stdout}\n${res.stderr ? "\n[STDERR]\n" + res.stderr : ""}`.trim()
        }
      ]
    };
  }

  if (name === "codex_worker_resume") {
    const psArgs = [
      "-Mode",
      args.fork ? "fork" : "resume",
      "-WorkerName",
      String(args.worker_name || "worker-resume"),
      "-Workdir",
      String(args.workdir || process.cwd()),
      "-Prompt",
      String(args.prompt || "")
    ];
    if (args.session_id) psArgs.push("-SessionId", String(args.session_id));
    if (args.full_access) psArgs.push("-FullAccess");
    if (args.use_wsl) psArgs.push("-UseWsl");

    const res = await runPowerShellWorker(psArgs);
    return {
      isError: res.code !== 0,
      content: [
        {
          type: "text",
          text: `${res.stdout}\n${res.stderr ? "\n[STDERR]\n" + res.stderr : ""}`.trim()
        }
      ]
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }]
  };
}

let useContentLengthFraming = false;

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

async function handleJsonRpc(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    const clientVersion = params?.protocolVersion || "2024-11-05";
    sendMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: clientVersion,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "codex-swarm-mcp",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "ping") {
    sendMessage({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    sendMessage({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS
      }
    });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      sendMessage({
        jsonrpc: "2.0",
        id,
        result
      });
    } catch (err) {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Internal error: ${String(err)}` }]
        }
      });
    }
    return;
  }

  if (id !== undefined) {
    sendMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    });
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const headerMatch = buffer.toString("utf8", 0, Math.min(buffer.length, 100)).match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
    if (headerMatch) {
      useContentLengthFraming = true;
      const headerByteLen = Buffer.byteLength(headerMatch[0], "utf8");
      const bodyByteLen = parseInt(headerMatch[1], 10);
      if (buffer.length < headerByteLen + bodyByteLen) {
        break;
      }
      const bodyStr = buffer.toString("utf8", headerByteLen, headerByteLen + bodyByteLen);
      buffer = buffer.subarray(headerByteLen + bodyByteLen);
      try {
        handleJsonRpc(JSON.parse(bodyStr));
      } catch {}
    } else {
      const newlineIdx = buffer.indexOf(0x0a); // \n
      if (newlineIdx === -1) break;
      const line = buffer.toString("utf8", 0, newlineIdx).trim();
      buffer = buffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        handleJsonRpc(JSON.parse(line));
      } catch {}
    }
  }
});
