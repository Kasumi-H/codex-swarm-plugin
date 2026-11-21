#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from '../runtime-config.mjs';

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
const OUT_DIR = getDataDir();

function buildEnhancedPath() {
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const home = os.homedir();
  const dirs = [];
  const addDir = (d) => {
    if (d && !dirs.includes(d) && fs.existsSync(d)) dirs.push(d);
  };

  addDir(path.dirname(process.execPath));

  if (isWin) {
    if (process.env.APPDATA) addDir(path.join(process.env.APPDATA, "npm"));
    addDir(path.join(home, ".codex", ".sandbox-bin"));
  } else {
    for (const d of [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".asdf", "shims"),
      path.join(home, ".local", "share", "mise", "shims"),
      path.join(home, ".nodenv", "shims"),
      path.join(home, ".fnm", "aliases", "default", "bin")
    ]) {
      addDir(d);
    }
    const nvmDir = path.join(home, ".nvm", "versions", "node");
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        for (const v of versions) addDir(path.join(nvmDir, v, "bin"));
      } catch {}
    }
  }

  for (const existing of (process.env.PATH || "").split(sep)) {
    if (existing && !dirs.includes(existing)) dirs.push(existing);
  }
  return dirs.join(sep);
}

function findLocalCodexBinary() {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const home = os.homedir();
  const extRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".antigravity", "extensions")
  ];
  const binName = isWin ? "codex.exe" : "codex";
  const archDirs = isWin
    ? ["windows-x86_64", "windows-arm64"]
    : isMac
      ? ["darwin-arm64", "darwin-x86_64"]
      : ["linux-x86_64", "linux-arm64"];

  const candidates = [];
  for (const root of extRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const d of fs.readdirSync(root).filter((x) => x.startsWith("openai.chatgpt-"))) {
        for (const arch of archDirs) {
          const p = path.join(root, d, "bin", arch, binName);
          if (fs.existsSync(p)) candidates.push(p);
        }
      }
    } catch {}
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length) return candidates[0];

  const sep = isWin ? ";" : ":";
  const pathDirs = buildEnhancedPath().split(sep);
  const names = isWin ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of pathDirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return "(not found in extensions or PATH)";
}

const TOOLS = [
  {
    name: "codex_worker_exec",
    description:
      "Delegate a coding, refactoring, testing, or debugging task to a local OpenAI Codex CLI subagent (macOS, Linux, Windows, or WSL). Saves Antigravity quota by letting local Codex execute the task.",
    inputSchema: {
      type: "object",
      properties: {
        worker_name: {
          type: "string",
          description: "Short identifier for this worker (e.g. 'backend-api', 'ui-worker', 'tests')."
        },
        workdir: {
          type: "string",
          description:
            "Absolute working directory path (e.g. /Users/<user>/project on macOS, /home/<user>/project on Linux, C:\\... on Windows, or \\\\wsl$\\Debian\\... for WSL)."
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
          description: "(Windows only) Force execution via WSL."
        },
        model: {
          type: "string",
          description: "Optional model override (defaults to right-pane settings.json or ~/.codex/config.toml)."
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Optional reasoning effort override."
        },
        with_architect: {
          type: "boolean",
          description: "If true, runs @architect (read-only) first to produce a blueprint before executing the worker."
        },
        no_auto_verify: {
          type: "boolean",
          description: "If true, skips the autonomous @worker <-> @verifier verification loop."
        },
        max_rounds: {
          type: "integer",
          description: "Optional maximum auto-verify rework rounds override."
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
        model: {
          type: "string",
          description: "Optional verifier model override."
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Optional reasoning effort override."
        },
        use_wsl: {
          type: "boolean",
          description: "(Windows only) Force execution via WSL."
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
        model: {
          type: "string",
          description: "Optional model override."
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Optional reasoning effort override."
        },
        use_wsl: {
          type: "boolean",
          description: "(Windows only) Force execution via WSL."
        }
      },
      required: ["workdir", "prompt"]
    }
  },
  {
    name: "codex_swarm_status",
    description:
      "Check local Codex CLI binaries (macOS, Linux, Windows & WSL), ~/.codex/config.toml settings, and recent Codex Swarm worker summary reports.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

function runWorker(workerArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT_MJS, ...workerArgs], {
      windowsHide: true,
      env: { ...process.env, PATH: buildEnhancedPath() }
    });

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
  const isWin = process.platform === "win32";

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
            `Platform: ${process.platform} (${os.arch()})`,
            `Node.js: ${process.execPath} (${process.version})`,
            `Detected Codex CLI: ${findLocalCodexBinary()}`,
            `Worker Script: ${WORKER_SCRIPT_MJS}`,
            `Output Directory: ${OUT_DIR}`,
            `Recent Worker Summaries:\n${summaries.length ? summaries.join("\n") : "(none yet)"}`,
            `\n~/.codex/config.toml:\n${configToml}`
          ].join("\n")
        }
      ]
    };
  }

  if (name === "codex_worker_exec") {
    const workerArgs = [
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
    if (args.full_access) workerArgs.push("-FullAccess");
    if (args.worktree) workerArgs.push("-Worktree");
    if (isWin && args.use_wsl) workerArgs.push("-UseWsl");
    if (args.model) workerArgs.push("-Model", String(args.model));
    if (args.reasoning_effort) workerArgs.push("-ReasoningEffort", String(args.reasoning_effort));
    if (args.with_architect) workerArgs.push("-WithArchitect");
    if (args.no_auto_verify) workerArgs.push("-NoAutoVerify");
    if (args.max_rounds) workerArgs.push("-MaxRounds", String(args.max_rounds));

    const res = await runWorker(workerArgs);
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
    const workerArgs = [
      "-Mode",
      "review",
      "-WorkerName",
      String(args.worker_name || "verifier"),
      "-Workdir",
      String(args.workdir || process.cwd())
    ];
    if (args.prompt) workerArgs.push("-Prompt", String(args.prompt));
    if (args.uncommitted !== false && !args.base_branch && !args.commit_sha) {
      workerArgs.push("-Uncommitted");
    }
    if (args.base_branch) workerArgs.push("-BaseBranch", String(args.base_branch));
    if (args.commit_sha) workerArgs.push("-CommitSha", String(args.commit_sha));
    if (args.model) workerArgs.push("-Model", String(args.model));
    if (args.reasoning_effort) workerArgs.push("-ReasoningEffort", String(args.reasoning_effort));
    if (isWin && args.use_wsl) workerArgs.push("-UseWsl");

    const res = await runWorker(workerArgs);
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
    const workerArgs = [
      "-Mode",
      args.fork ? "fork" : "resume",
      "-WorkerName",
      String(args.worker_name || "worker-resume"),
      "-Workdir",
      String(args.workdir || process.cwd()),
      "-Prompt",
      String(args.prompt || "")
    ];
    if (args.session_id) workerArgs.push("-SessionId", String(args.session_id));
    if (args.full_access) workerArgs.push("-FullAccess");
    if (args.model) workerArgs.push("-Model", String(args.model));
    if (args.reasoning_effort) workerArgs.push("-ReasoningEffort", String(args.reasoning_effort));
    if (isWin && args.use_wsl) workerArgs.push("-UseWsl");

    const res = await runWorker(workerArgs);
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

async function handleJsonRpc(msg, framed) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  const sendMessage = (response) => {
    const json = JSON.stringify(response);
    process.stdout.write(framed
      ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
      : json + "\n");
  };

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
    const newlineIdx = buffer.indexOf(0x0a);
    if (newlineIdx === -1) break;
    const line = buffer.toString("utf8", 0, newlineIdx).trim();
    const length = line.match(/^Content-Length:[ \t]*(\d+)$/i);
    let message = line;
    let end = newlineIdx + 1;
    if (length) {
      const separator = buffer[newlineIdx - 1] === 0x0d ? "\r\n\r\n" : "\n\n";
      const headerEnd = buffer.indexOf(separator, newlineIdx - (separator.length === 4 ? 1 : 0));
      if (headerEnd === -1) break;
      const start = headerEnd + separator.length;
      end = start + Number(length[1]);
      if (buffer.length < end) break;
      message = buffer.toString("utf8", start, end);
    }
    buffer = buffer.subarray(end);
    try {
      handleJsonRpc(JSON.parse(message), Boolean(length));
    } catch {}
  }
});
