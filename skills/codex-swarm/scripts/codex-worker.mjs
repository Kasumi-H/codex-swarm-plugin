#!/usr/bin/env node
/**
 * Cross-Platform Codex Swarm Worker & Autonomous Peer-to-Peer Loop Engine
 * Supports: macOS (Apple Silicon & Intel), Linux, Windows Native, and WSL.
 *
 * Usage:
 *   node codex-worker.mjs -WorkerName "coder" -Workdir "/path/to/repo" -PromptFile "/path/to/brief.md"
 *   node codex-worker.mjs -Mode "post" -WorkerName "coordinator" -To "all" -SwarmTitle "Title" -Prompt "..."
 *   node codex-worker.mjs --check
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '../../../runtime-config.mjs';

// 1. Parse CLI arguments (supports both PowerShell-style -WorkerName and --worker-name)
function parseArgs(argv) {
  const opts = {
    workerName: 'worker',
    workdir: process.cwd(),
    prompt: '',
    promptFile: '',
    mode: 'exec',
    swarmTitle: '',
    to: '',
    sandbox: '',
    fullAccess: false,
    worktree: false,
    sessionId: '',
    model: '',
    reasoningEffort: '',
    uncommitted: false,
    baseBranch: '',
    commitSha: '',
    ephemeral: false,
    persistSession: false,
    autoVerify: false,
    noAutoVerify: false,
    withArchitect: false,
    maxRounds: 0,
    useWsl: false,
    check: false,
    help: false,
    outDir: getDataDir()
  };

  const normKey = (k) => k.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const boolFlags = new Set([
    'fullAccess',
    'worktree',
    'uncommitted',
    'ephemeral',
    'persistSession',
    'autoVerify',
    'noAutoVerify',
    'withArchitect',
    'useWsl',
    'check',
    'help',
    'h'
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;
    const rawKey = normKey(arg);
    const key = rawKey.charAt(0).toLowerCase() + rawKey.slice(1);
    if (key === 'h') {
      opts.help = true;
    } else if (boolFlags.has(key)) {
      opts[key] = true;
    } else if (key in opts && i + 1 < argv.length) {
      const val = argv[++i];
      opts[key] = key === 'maxRounds' ? parseInt(val, 10) || 0 : val;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log([
    'Codex Swarm Worker (Cross-Platform Node.js Engine)',
    '',
    'Usage:',
    '  node codex-worker.mjs -WorkerName <name> -Workdir <dir> -PromptFile <file> [options]',
    '  node codex-worker.mjs -Mode post -WorkerName coordinator -To all -SwarmTitle <title> -Prompt <text>',
    '  node codex-worker.mjs --check',
    '',
    'Options:',
    '  -Mode            exec | review | resume | fork | post (default: exec)',
    '  -WorkerName      Worker identifier (default: worker)',
    '  -Workdir         Target working directory (default: cwd)',
    '  -Prompt          Inline prompt text',
    '  -PromptFile      UTF-8 file containing prompt text',
    '  -Sandbox         workspace-write | read-only | danger-full-access',
    '  -Model           Model slug override',
    '  -ReasoningEffort low | medium | high | xhigh | max | ultra',
    '  -WithArchitect   Run @architect (read-only) blueprint stage before worker',
    '  -AutoVerify      Force enable @worker <-> @verifier loop',
    '  -NoAutoVerify    Disable @worker <-> @verifier loop',
    '  -MaxRounds       Maximum verification rounds (default: 3)',
    '  -Ephemeral       Do not persist session in Codex Desktop sidebar',
    '  -PersistSession  Persist session in Codex Desktop sidebar',
    '  -Worktree        Run worker in an isolated git worktree',
    '  -FullAccess      Pass --dangerously-bypass-approvals-and-sandbox',
    '  -UseWsl          (Windows only) Run Codex inside WSL',
    '  -OutDir          Override plugin_data output directory',
    '  --check          Print detected platform, Node, and Codex CLI paths and exit'
  ].join('\n'));
  process.exit(0);
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function buildEnhancedPath() {
  const sep = isWin ? ';' : ':';
  const home = os.homedir();
  const dirs = [];
  const addDir = (d) => {
    if (d && !dirs.includes(d) && fs.existsSync(d)) dirs.push(d);
  };

  addDir(path.dirname(process.execPath));

  if (isWin) {
    if (process.env.APPDATA) addDir(path.join(process.env.APPDATA, 'npm'));
    addDir(path.join(home, '.codex', '.sandbox-bin'));
  } else {
    for (const d of [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.nodenv', 'shims'),
      path.join(home, '.fnm', 'aliases', 'default', 'bin')
    ]) {
      addDir(d);
    }
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        for (const v of versions) addDir(path.join(nvmDir, v, 'bin'));
      } catch {}
    }
  }

  for (const existing of (process.env.PATH || '').split(sep)) {
    if (existing && !dirs.includes(existing)) dirs.push(existing);
  }
  return dirs.join(sep);
}

function findLocalCodexBinary() {
  const home = os.homedir();
  const extRoots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.antigravity', 'extensions')
  ];
  const binName = isWin ? 'codex.exe' : 'codex';
  const archDirs = isWin
    ? ['windows-x86_64', 'windows-arm64']
    : isMac
      ? ['darwin-arm64', 'darwin-x86_64']
      : ['linux-x86_64', 'linux-arm64'];

  const candidates = [];
  for (const root of extRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const d of fs.readdirSync(root).filter((x) => x.startsWith('openai.chatgpt-'))) {
        for (const arch of archDirs) {
          const p = path.join(root, d, 'bin', arch, binName);
          if (fs.existsSync(p)) candidates.push(p);
        }
      }
    } catch {}
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length) return candidates[0];

  const sep = isWin ? ';' : ':';
  const pathDirs = buildEnhancedPath().split(sep);
  const names = isWin ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  for (const dir of pathDirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return binName;
}

if (opts.check) {
  console.log('==========================================================');
  console.log('  Codex Swarm Worker — Environment Diagnostics');
  console.log(`  Platform   : ${process.platform} (${os.arch()})`);
  console.log(`  Node.js    : ${process.execPath} (${process.version})`);
  console.log(`  Codex CLI  : ${findLocalCodexBinary()}`);
  console.log(`  OutDir     : ${opts.outDir}`);
  console.log('==========================================================');
  process.exit(0);
}

if (!fs.existsSync(opts.outDir)) {
  fs.mkdirSync(opts.outDir, { recursive: true });
}

const settingsPath = path.join(opts.outDir, 'settings.json');
const membersPath = path.join(opts.outDir, 'members.json');
const boardPath = path.join(opts.outDir, 'board.jsonl');
const lockPath = path.join(opts.outDir, 'board.lock');
const STALE_LOCK_MS = 15000;

function withBoardLock(fn) {
  const start = Date.now();
  let fd = null;
  while (Date.now() - start < 5000) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

function loadSettings() {
  const defaults = {
    swarmTitle: 'Codex Swarm 协作看板',
    defaultModel: 'gpt-6.1-terra',
    defaultReasoningEffort: 'high',
    verifierModel: 'gpt-6.2-sol',
    verifierReasoningEffort: 'high',
    defaultSandbox: 'workspace-write',
    defaultRuntime: 'auto',
    ephemeral: true,
    worktree: false,
    autoVerify: true,
    maxRounds: 3,
    presets: []
  };
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    return defaults;
  }
}

function addBoardPost(post) {
  return withBoardLock(() => {
    let maxSeq = 0;
    if (fs.existsSync(boardPath)) {
      const lines = fs.readFileSync(boardPath, 'utf8').split(/\r?\n/);
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const obj = JSON.parse(l);
          if (Number(obj.seq) > maxSeq) maxSeq = Number(obj.seq);
        } catch {}
      }
    }
    const seq = maxSeq + 1;
    const entry = {
      ...post,
      to: Array.isArray(post.to) ? post.to : post.to ? String(post.to).split(',').map((s) => s.trim()).filter(Boolean) : ['all'],
      seq,
      ts: new Date().toISOString()
    };
    fs.appendFileSync(boardPath, JSON.stringify(entry) + '\n', 'utf8');
    return seq;
  });
}

function updateMemberState(name, props) {
  withBoardLock(() => {
    let map = {};
    if (fs.existsSync(membersPath)) {
      try { map = JSON.parse(fs.readFileSync(membersPath, 'utf8')) || {}; } catch {}
    }
    map[name] = { ...(map[name] || { name }), ...props };
    fs.writeFileSync(membersPath, JSON.stringify(map, null, 2), 'utf8');
  });
}

const uiSettings = loadSettings();

if (opts.swarmTitle) {
  withBoardLock(() => {
    const s = loadSettings();
    s.swarmTitle = opts.swarmTitle;
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  });
}

let promptText = opts.prompt;
if (opts.promptFile && fs.existsSync(opts.promptFile)) {
  promptText = fs.readFileSync(path.resolve(opts.promptFile), 'utf8');
}

if (opts.mode === 'post') {
  const targets = opts.to ? opts.to.split(',').map((s) => s.trim()).filter(Boolean) : ['all'];
  addBoardPost({
    from: opts.workerName,
    to: targets,
    role: opts.workerName === 'coordinator' ? 'coordinator' : 'worker',
    type: 'note',
    status: '',
    text: promptText
  });
  console.log(`[Codex Swarm Board] Posted message from @${opts.workerName} to ${targets.join(', ')}`);
  process.exit(0);
}

if (!promptText && opts.mode !== 'review') {
  console.error(`Error: Prompt or PromptFile must be provided for Mode '${opts.mode}'.`);
  process.exit(1);
}

function getPresetByName(targetName) {
  return (uiSettings.presets || []).find((p) => p.name === targetName) || null;
}

const matchedPreset = getPresetByName(opts.workerName);
const isVerifierRole = opts.mode === 'review' || /verifier|review/i.test(opts.workerName);

const effectiveModel = opts.model || matchedPreset?.model || (isVerifierRole ? uiSettings.verifierModel : uiSettings.defaultModel);
const effectiveEffort = opts.reasoningEffort || matchedPreset?.reasoningEffort || (isVerifierRole ? uiSettings.verifierReasoningEffort : uiSettings.defaultReasoningEffort);
const effectiveSandbox = opts.sandbox || matchedPreset?.sandbox || uiSettings.defaultSandbox;
const effectiveEphemeral = opts.persistSession ? false : opts.ephemeral ? true : Boolean(uiSettings.ephemeral);
const effectiveWorktree = opts.worktree || Boolean(uiSettings.worktree);
const effectiveAutoVerify =
  opts.noAutoVerify || isVerifierRole || opts.mode !== 'exec' || (effectiveSandbox === 'read-only' && !opts.fullAccess)
    ? false
    : opts.autoVerify
      ? true
      : Boolean(uiSettings.autoVerify);
const effectiveMaxRounds = opts.maxRounds > 0 ? opts.maxRounds : Number(uiSettings.maxRounds) || 3;

function getWslUncPath(value) {
  return value.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i);
}

const wslWorkdir = getWslUncPath(opts.workdir);
const wslDistro = wslWorkdir?.[1];
const isWslTarget = isWin &&
  (opts.useWsl || uiSettings.defaultRuntime === 'wsl' || wslWorkdir || opts.workdir.startsWith('/'));
const wslArgs = wslDistro ? ['--distribution', wslDistro, '--'] : ['--'];
const runtimeLabel = isWslTarget ? (wslDistro ? `WSL (${wslDistro})` : 'WSL (default)') :
  isMac ? 'macOS Native' : isWin ? 'Windows Native' : 'Linux Native';

function shellQuoteSingle(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function toWslPath(p) {
  if (p.startsWith('/')) return p;
  const unc = getWslUncPath(p);
  if (unc) {
    const activeDistro = wslDistro || execFileSync('wsl', [...wslArgs, 'printenv', 'WSL_DISTRO_NAME'], { encoding: 'utf8' }).trim();
    if (unc[1].toLowerCase() !== activeDistro.toLowerCase()) {
      throw new Error('WSL path belongs to a different distribution: ' + p);
    }
    return (unc[2] || '\\').replace(/\\/g, '/');
  }
  const norm = p.replace(/\\/g, '/');
  return execFileSync('wsl', [...wslArgs, 'wslpath', '-u', norm], { encoding: 'utf8' }).trim();
}

let activeChild = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (activeChild && !activeChild.killed) {
      try { activeChild.kill(sig); } catch {}
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

function invokeCodexTurn({ agentName, agentRole, turnMode, turnPrompt, turnModel, turnEffort, turnSandbox, turnFullAccess }) {
  return new Promise((resolve) => {
    const safeAgent = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const turnBriefFile = path.join(opts.outDir, `${safeAgent}-brief.md`);
    const turnSummaryFile = path.join(opts.outDir, `${safeAgent}-summary.md`);
    const turnLogFile = path.join(opts.outDir, `${safeAgent}-${ts}.log`);

    if (fs.existsSync(turnSummaryFile)) {
      try { fs.unlinkSync(turnSummaryFile); } catch {}
    }
    if (turnPrompt) {
      fs.writeFileSync(turnBriefFile, turnPrompt, 'utf8');
    }
    fs.writeFileSync(turnLogFile, '', 'utf8');

    updateMemberState(agentName, {
      name: agentName,
      role: agentRole,
      status: 'working',
      model: turnModel,
      reasoningEffort: turnEffort,
      sandbox: turnFullAccess ? 'danger-full-access' : turnSandbox,
      runtime: runtimeLabel,
      workdir: opts.workdir,
      ephemeral: effectiveEphemeral,
      brief: turnPrompt || '[Code Review]',
      logFile: turnLogFile,
      summaryFile: turnSummaryFile,
      startedAt: new Date().toISOString()
    });

    const startMs = Date.now();
    let settled = false;
    const finishTurn = (exitCode, extraError = '') => {
      if (settled) return;
      settled = true;
      activeChild = null;
      if (extraError) {
        fs.appendFileSync(turnLogFile, extraError + '\n', 'utf8');
        process.stderr.write(extraError + '\n');
      }
      const elapsed = Math.round(((Date.now() - startMs) / 1000) * 10) / 10;
      let summary = '';
      if (fs.existsSync(turnSummaryFile)) {
        summary = fs.readFileSync(turnSummaryFile, 'utf8').trim();
      } else if (fs.existsSync(turnLogFile)) {
        const lines = fs.readFileSync(turnLogFile, 'utf8').split(/\r?\n/);
        summary = lines.slice(-30).join('\n').trim();
      }
      if (!summary && extraError) summary = extraError;
      const status = exitCode === 0 ? 'done' : 'failed';
      updateMemberState(agentName, {
        status,
        exitCode,
        elapsedSec: elapsed,
        summary,
        finishedAt: new Date().toISOString()
      });
      resolve({ exitCode, elapsed, summary, status, logFile: turnLogFile });
    };

    let child;
    try {
      if (!isWslTarget) {
        const codexBin = findLocalCodexBinary();
        if (!fs.existsSync(opts.workdir)) {
          fs.mkdirSync(opts.workdir, { recursive: true });
        }
        const args = [];
        if (turnMode === 'exec') {
          args.push('exec', '-C', opts.workdir);
          if (turnFullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
          else args.push('-s', turnSandbox);
          if (effectiveWorktree && agentRole !== 'verifier') args.push('--worktree');
          else args.push('--skip-git-repo-check');
          if (effectiveEphemeral) args.push('--ephemeral');
          if (turnModel) args.push('-m', turnModel);
          if (turnEffort) args.push('-c', `model_reasoning_effort="${turnEffort}"`);
          args.push('--color', 'never', '-o', turnSummaryFile, '-');
        } else if (turnMode === 'resume' || turnMode === 'fork') {
          args.push('exec', turnMode, opts.sessionId || '--last');
          if (turnFullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
          if (effectiveWorktree) args.push('--worktree');
          else args.push('--skip-git-repo-check');
          if (turnModel) args.push('-m', turnModel);
          if (turnEffort) args.push('-c', `model_reasoning_effort="${turnEffort}"`);
          args.push('-o', turnSummaryFile, '-');
        } else if (turnMode === 'review') {
          args.push('review');
          if (turnModel) args.push('-c', `model="${turnModel}"`);
          if (turnEffort) args.push('-c', `model_reasoning_effort="${turnEffort}"`);
          if (opts.uncommitted || (!opts.baseBranch && !opts.commitSha)) args.push('--uncommitted');
          if (opts.baseBranch) args.push('--base', opts.baseBranch);
          if (opts.commitSha) args.push('--commit', opts.commitSha);
          if (turnPrompt) args.push('-');
        }

        const needsShell = isWin && /\.(cmd|bat)$/i.test(codexBin);
        child = spawn(codexBin, args, {
          cwd: opts.workdir,
          windowsHide: true,
          shell: needsShell,
          env: { ...process.env, PATH: buildEnhancedPath() }
        });
        activeChild = child;
        if (turnPrompt) child.stdin.write(turnPrompt, 'utf8');
        child.stdin.end();
      } else {
        const wslWorkdir = toWslPath(opts.workdir);
        const wslSummaryFile = toWslPath(turnSummaryFile);
        const wslBriefFile = turnPrompt ? toWslPath(turnBriefFile) : '';
        const parts = ['codex'];
        if (turnMode === 'exec') {
          parts.push('exec', '-C', shellQuoteSingle(wslWorkdir));
          if (turnFullAccess) parts.push('--dangerously-bypass-approvals-and-sandbox');
          else parts.push('-s', shellQuoteSingle(turnSandbox));
          if (effectiveWorktree && agentRole !== 'verifier') parts.push('--worktree');
          else parts.push('--skip-git-repo-check');
          if (effectiveEphemeral) parts.push('--ephemeral');
          if (turnModel) parts.push('-m', shellQuoteSingle(turnModel));
          if (turnEffort) parts.push('-c', shellQuoteSingle(`model_reasoning_effort="${turnEffort}"`));
          parts.push('--color', 'never', '-o', shellQuoteSingle(wslSummaryFile), '-');
        } else if (turnMode === 'resume' || turnMode === 'fork') {
          parts.push('exec', turnMode, opts.sessionId ? shellQuoteSingle(opts.sessionId) : '--last');
          if (turnFullAccess) parts.push('--dangerously-bypass-approvals-and-sandbox');
          if (effectiveWorktree) parts.push('--worktree');
          else parts.push('--skip-git-repo-check');
          if (turnModel) parts.push('-m', shellQuoteSingle(turnModel));
          if (turnEffort) parts.push('-c', shellQuoteSingle(`model_reasoning_effort="${turnEffort}"`));
          parts.push('-o', shellQuoteSingle(wslSummaryFile), '-');
        } else if (turnMode === 'review') {
          parts.push('review');
          if (turnModel) parts.push('-c', shellQuoteSingle(`model="${turnModel}"`));
          if (turnEffort) parts.push('-c', shellQuoteSingle(`model_reasoning_effort="${turnEffort}"`));
          if (opts.uncommitted || (!opts.baseBranch && !opts.commitSha)) parts.push('--uncommitted');
          if (opts.baseBranch) parts.push('--base', shellQuoteSingle(opts.baseBranch));
          if (opts.commitSha) parts.push('--commit', shellQuoteSingle(opts.commitSha));
          if (turnPrompt) parts.push('-');
        }
        const qWorkdir = shellQuoteSingle(wslWorkdir);
        const cmd = wslBriefFile
          ? `export PATH="$HOME/.local/bin:$PATH"; mkdir -p ${qWorkdir} && cd ${qWorkdir} && ${parts.join(' ')} < ${shellQuoteSingle(wslBriefFile)}`
          : `export PATH="$HOME/.local/bin:$PATH"; cd ${qWorkdir} && ${parts.join(' ')} </dev/null`;
        child = spawn('wsl', [...wslArgs, 'bash', '-lc', cmd], { windowsHide: true });
        activeChild = child;
      }
    } catch (err) {
      finishTurn(1, `[Codex Swarm Error] Failed to launch Codex CLI: ${String(err)}`);
      return;
    }

    const onChunk = (chunk) => {
      const str = chunk.toString('utf8');
      fs.appendFileSync(turnLogFile, str, 'utf8');
      process.stdout.write(str);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (err) => {
      finishTurn(1, `[Codex Swarm Error] Could not spawn Codex CLI: ${err.message || String(err)}`);
    });
    child.on('close', (code) => {
      finishTurn(code ?? 1);
    });
  });
}

async function main() {
  // =========================================================================
  // Stage 0 (Optional): @architect pre-analysis -> hands off blueprint
  // =========================================================================
  let architectBlueprint = '';
  if (opts.withArchitect && opts.mode === 'exec' && opts.workerName !== 'architect') {
    const archPreset = getPresetByName('architect');
    const archModel = archPreset?.model || uiSettings.verifierModel;
    const archEffort = archPreset?.reasoningEffort || 'high';

    addBoardPost({
      from: 'coordinator',
      to: ['architect'],
      role: 'coordinator',
      type: 'assign',
      status: 'working',
      model: archModel,
      reasoningEffort: archEffort,
      sandbox: 'read-only',
      runtime: runtimeLabel,
      workdir: opts.workdir,
      ephemeral: effectiveEphemeral,
      text: `[架构预研派单 -> 完成后自动交接给 @${opts.workerName}]\n${promptText}`
    });

    const archPrompt = [
      `你是 Codex Swarm 的架构师 (@architect)，当前处于只读模式 (read-only)。`,
      `请针对以下任务快速阅读并分析工作区 (${opts.workdir}) 的关键文件，输出一份简明扼要、可直接供执行子 Agent (@${opts.workerName}) 落地的【实施蓝图与关键注意事项】（不要自己修改文件）：`,
      '',
      promptText
    ].join('\n');

    const archRes = await invokeCodexTurn({
      agentName: 'architect',
      agentRole: 'worker',
      turnMode: 'exec',
      turnPrompt: archPrompt,
      turnModel: archModel,
      turnEffort: archEffort,
      turnSandbox: 'read-only',
      turnFullAccess: false
    });
    architectBlueprint = archRes.summary;

    addBoardPost({
      from: 'architect',
      to: [opts.workerName],
      role: 'worker',
      type: 'assign',
      status: archRes.exitCode === 0 ? 'done' : 'failed',
      exitCode: archRes.exitCode,
      elapsedSec: archRes.elapsed,
      model: archModel,
      reasoningEffort: archEffort,
      sandbox: 'read-only',
      runtime: runtimeLabel,
      workdir: opts.workdir,
      ephemeral: effectiveEphemeral,
      text: `[架构蓝图交接 -> @${opts.workerName}]\n${architectBlueprint}`
    });
  }

  // =========================================================================
  // Stage 1 & 2: Main Worker Execution + Autonomous @worker <-> @verifier Loop
  // =========================================================================
  const roleLabel = isVerifierRole ? 'verifier' : 'worker';
  const briefDisplay = promptText || '[Code Review] 审查当前仓库未提交变更 (--uncommitted)';

  if (!opts.withArchitect) {
    addBoardPost({
      from: 'coordinator',
      to: [opts.workerName],
      role: 'coordinator',
      type: 'assign',
      status: 'working',
      model: effectiveModel,
      reasoningEffort: effectiveEffort,
      sandbox: opts.fullAccess ? 'danger-full-access' : effectiveSandbox,
      runtime: runtimeLabel,
      workdir: opts.workdir,
      ephemeral: effectiveEphemeral,
      text: briefDisplay
    });
  }

  console.log('==========================================================');
  console.log(`[Codex Swarm Worker] @${opts.workerName}`);
  console.log(`  Mode       : ${opts.mode} (${roleLabel})`);
  console.log(`  Model      : ${effectiveModel} (Reasoning Effort: ${effectiveEffort})`);
  console.log(`  AutoVerify : ${effectiveAutoVerify} (MaxRounds: ${effectiveMaxRounds})`);
  console.log(`  Ephemeral  : ${effectiveEphemeral} (不污染 Codex 桌面版会话)`);
  console.log(`  Workdir    : ${opts.workdir}`);
  console.log(`  Runtime    : ${runtimeLabel}`);
  console.log('==========================================================');

  const verifierPreset = getPresetByName('verifier');
  const vModel = verifierPreset?.model || uiSettings.verifierModel;
  const vEffort = verifierPreset?.reasoningEffort || uiSettings.verifierReasoningEffort;

  let round = 1;
  let currentPrompt = architectBlueprint
    ? `${promptText}\n\n[来自 @architect 的架构蓝图与实施建议]\n${architectBlueprint}`
    : promptText;
  let finalRes = null;
  let finalVerifierRes = null;

  while (round <= effectiveMaxRounds) {
    console.log(`--- [@${opts.workerName}] Executing Round ${round} ---`);
    const workerRes = await invokeCodexTurn({
      agentName: opts.workerName,
      agentRole: roleLabel,
      turnMode: opts.mode,
      turnPrompt: currentPrompt,
      turnModel: effectiveModel,
      turnEffort: effectiveEffort,
      turnSandbox: effectiveSandbox,
      turnFullAccess: opts.fullAccess
    });
    finalRes = workerRes;

    if (!effectiveAutoVerify || workerRes.exitCode !== 0) {
      const prefix = workerRes.exitCode === 0 ? '[done] ' : `[error (exit ${workerRes.exitCode})] `;
      addBoardPost({
        from: opts.workerName,
        to: ['coordinator'],
        role: roleLabel,
        type: workerRes.status,
        status: workerRes.status,
        exitCode: workerRes.exitCode,
        elapsedSec: workerRes.elapsed,
        model: effectiveModel,
        reasoningEffort: effectiveEffort,
        sandbox: opts.fullAccess ? 'danger-full-access' : effectiveSandbox,
        runtime: runtimeLabel,
        workdir: opts.workdir,
        ephemeral: effectiveEphemeral,
        text: prefix + workerRes.summary
      });
      break;
    }

    const workerPostSeq = addBoardPost({
      from: opts.workerName,
      to: ['verifier'],
      role: roleLabel,
      type: 'assign',
      status: 'done',
      exitCode: workerRes.exitCode,
      elapsedSec: workerRes.elapsed,
      model: effectiveModel,
      reasoningEffort: effectiveEffort,
      sandbox: opts.fullAccess ? 'danger-full-access' : effectiveSandbox,
      runtime: runtimeLabel,
      workdir: opts.workdir,
      ephemeral: effectiveEphemeral,
      text: `[第 ${round} 轮完成，提请 @verifier 独立核验]\n${workerRes.summary}`
    });

    console.log(`--- [@verifier] Auto-verifying @${opts.workerName} (Round ${round}, Post #${workerPostSeq}) ---`);
    const verifierPrompt = [
      `你是 Codex Swarm 的独立验证官 (@verifier，只读核验，严禁亲自修改任何工程文件)。`,
      `请全面核验 #${workerPostSeq} (@${opts.workerName} 的第 ${round} 轮修改) 在工作区 (${opts.workdir}) 中的实际落地情况。`,
      `\n[原始任务要求]\n${promptText}`,
      `\n[@${opts.workerName} 第 ${round} 轮汇报 (#${workerPostSeq})]\n${workerRes.summary}`,
      `\n请你直接检查工作区中的实际文件 / git diff 或运行只读校验命令，核查是否存在遗漏、语法错误、未同步修改、越界修改或未满足的验收条件。`,
      `\n【输出格式要求（必须严格遵守）】`,
      `1. 如果所有检查项全部通过、0 阻断缺陷：请务必在回复的第一行以 [PASS] 开头，随后写出你的核验通过报告。`,
      `2. 如果检出任何需要 @${opts.workerName} 修复的问题：请务必在回复的第一行以 [REWORK] 开头，并逐项列出具体问题、文件路径及修复要求，以便自动打回给 @${opts.workerName} 重修。`
    ].join('\n');

    const verRes = await invokeCodexTurn({
      agentName: 'verifier',
      agentRole: 'verifier',
      turnMode: 'exec',
      turnPrompt: verifierPrompt,
      turnModel: vModel,
      turnEffort: vEffort,
      turnSandbox: 'read-only',
      turnFullAccess: false
    });
    finalVerifierRes = verRes;

    const needsRework = /\[REWORK\]/.test(verRes.summary) && !/^\s*\[PASS\]/.test(verRes.summary);
    if (!needsRework) {
      addBoardPost({
        from: 'verifier',
        to: ['coordinator'],
        role: 'verifier',
        type: 'done',
        status: 'done',
        exitCode: verRes.exitCode,
        elapsedSec: verRes.elapsed,
        model: vModel,
        reasoningEffort: vEffort,
        sandbox: 'read-only',
        runtime: runtimeLabel,
        workdir: opts.workdir,
        ephemeral: effectiveEphemeral,
        text: `[done] 已完成对 #${workerPostSeq} (@${opts.workerName} 第 ${round} 轮提交) 的独立核验，全部 PASS：\n${verRes.summary}`
      });
      break;
    }

    if (round < effectiveMaxRounds) {
      const reworkSeq = addBoardPost({
        from: 'verifier',
        to: [opts.workerName],
        role: 'verifier',
        type: 'assign',
        status: 'working',
        exitCode: verRes.exitCode,
        elapsedSec: verRes.elapsed,
        model: vModel,
        reasoningEffort: vEffort,
        sandbox: 'read-only',
        runtime: runtimeLabel,
        workdir: opts.workdir,
        ephemeral: effectiveEphemeral,
        text: `[检出问题 -> 打回 @${opts.workerName} 第 ${round + 1} 轮返工修复]\n${verRes.summary}`
      });
      currentPrompt = [
        `[来自独立验证官 @verifier 的返工要求 (#${reworkSeq})]`,
        `你在第 ${round} 轮提交的修改经 @verifier 核验检出以下问题，请立即在工作区 (${opts.workdir}) 中逐项修复（修复后请自测确认）：`,
        '',
        verRes.summary,
        '',
        '---',
        '[附：原始任务要求]',
        promptText
      ].join('\n');
      round++;
    } else {
      addBoardPost({
        from: 'verifier',
        to: ['coordinator'],
        role: 'verifier',
        type: 'done',
        status: 'failed',
        exitCode: verRes.exitCode,
        elapsedSec: verRes.elapsed,
        model: vModel,
        reasoningEffort: vEffort,
        sandbox: 'read-only',
        runtime: runtimeLabel,
        workdir: opts.workdir,
        ephemeral: effectiveEphemeral,
        text: `[已达最大自动互审轮数 ${effectiveMaxRounds}，仍有待处理项，提请 @coordinator 介入]\n${verRes.summary}`
      });
      break;
    }
  }

  console.log('');
  console.log('==========================================================');
  console.log(`[Codex Swarm] @${opts.workerName} workflow finished (Rounds: ${round})`);
  console.log('==========================================================');
  if (finalRes?.summary) {
    console.log(`--- @${opts.workerName} Final Summary ---`);
    console.log(finalRes.summary);
  }
  if (finalVerifierRes?.summary) {
    console.log('');
    console.log('--- @verifier Final Review ---');
    console.log(finalVerifierRes.summary);
  }

  process.exit(finalRes ? finalRes.exitCode : 0);
}

main();
