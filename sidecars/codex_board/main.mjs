/**
 * Codex Swarm Board & Subagent Configurator Sidecar Backend.
 *
 * Serves the right-pane UI for Codex Swarm:
 * - Overview (概览)
 * - Board (看板 - 实时协调消息流)
 * - Members (成员 - 子 Agent 状态、实时日志、模型与推理强度)
 * - Config (配置 - 默认/各子 Agent 模型、推理思考强度、无痕防污染开关 --ephemeral)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'codex-swarm');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
const MEMBERS_PATH = join(DATA_DIR, 'members.json');
const BOARD_PATH = join(DATA_DIR, 'board.jsonl');
const CODEX_HOME = join(homedir(), '.codex');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

const DEFAULT_SETTINGS = {
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
  stallTimeoutMin: 8,
  presets: [
    {
      name: 'architect',
      role: 'worker',
      model: 'gpt-6.2-sol',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      desc: '架构分析、接口设计与复杂问题排查'
    },
    {
      name: 'coder',
      role: 'worker',
      model: 'gpt-6.1-terra',
      reasoningEffort: 'high',
      sandbox: 'workspace-write',
      desc: '主力业务代码实现、重构与单测编写'
    },
    {
      name: 'fast-worker',
      role: 'worker',
      model: 'gpt-6.1-terra',
      reasoningEffort: 'medium',
      sandbox: 'workspace-write',
      desc: '轻量级模块修改、脚本与文档整理'
    },
    {
      name: 'verifier',
      role: 'verifier',
      model: 'gpt-6.2-sol',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      desc: '独立代码审查官 (codex review / 验收测试)'
    }
  ]
};

function loadSettings() {
  ensureDataDir();
  if (!existsSync(SETTINGS_PATH)) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf-8');
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      presets: Array.isArray(raw.presets) ? raw.presets : DEFAULT_SETTINGS.presets
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = {
    ...current,
    ...patch,
    presets: Array.isArray(patch.presets) ? patch.presets : current.presets
  };
  ensureDataDir();
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

let modelsCache = { at: 0, list: null };
const MODELS_TTL_MS = 10 * 60 * 1000;

function findCodexExe() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  try {
    const extRoot = join(homedir(), '.vscode', 'extensions');
    if (existsSync(extRoot)) {
      const binName = isWin ? 'codex.exe' : 'codex';
      const archDirs = isWin
        ? ['windows-x86_64', 'windows-arm64']
        : isMac
          ? ['darwin-arm64', 'darwin-x86_64']
          : ['linux-x86_64', 'linux-arm64'];
      const candidates = [];
      for (const d of readdirSync(extRoot).filter((x) => x.startsWith('openai.chatgpt-'))) {
        for (const arch of archDirs) {
          const p = join(extRoot, d, 'bin', arch, binName);
          if (existsSync(p)) candidates.push(p);
        }
      }
      candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    }
  } catch {}
  if (!isWin) {
    for (const p of [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      join(homedir(), '.local', 'bin', 'codex'),
      join(homedir(), '.bun', 'bin', 'codex')
    ]) {
      if (existsSync(p)) return p;
    }
  }
  return 'codex';
}

function normalizeModels(arr) {
  return arr
    .filter((m) => m && m.slug && m.visibility !== 'hide')
    .map((m) => ({
      slug: m.slug,
      displayName: m.display_name || m.slug,
      description: m.description || '',
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((r) => r.effort)
        : ['low', 'medium', 'high', 'xhigh']
    }));
}

// Live catalog from `codex debug models` (always current), cached 10 minutes;
// falls back to ~/.codex/models_cache.json (may be stale), then a static list.
function loadAvailableModels() {
  if (modelsCache.list && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.list;
  const E = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const fallback = [
    { slug: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', efforts: E },
    { slug: 'gpt-6.2-astra', displayName: 'GPT-6.2-Astra', efforts: E },
    { slug: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: E },
    { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', efforts: E },
    { slug: 'gpt-6-astra', displayName: 'GPT-6-Astra', efforts: E },
    { slug: 'gpt-6-sol', displayName: 'GPT-6-Sol', efforts: E },
    { slug: 'gpt-6-luna', displayName: 'GPT-6-Luna', efforts: E.slice(0, 5) },
    { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', efforts: E }
  ];
  let list = null;
  try {
    const out = execFileSync(findCodexExe(), ['debug', 'models'], { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    const parsed = JSON.parse(out);
    const arr = Array.isArray(parsed) ? parsed : parsed.models;
    if (Array.isArray(arr)) list = normalizeModels(arr);
  } catch {}
  if (!list || !list.length) {
    try {
      const parsed = JSON.parse(readFileSync(join(CODEX_HOME, 'models_cache.json'), 'utf-8'));
      if (Array.isArray(parsed.models)) list = normalizeModels(parsed.models);
    } catch {}
  }
  if (!list || !list.length) list = fallback;
  modelsCache = { at: Date.now(), list };
  return list;
}
function loadMembers() {
  ensureDataDir();
  if (!existsSync(MEMBERS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MEMBERS_PATH, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveMembers(members) {
  ensureDataDir();
  writeFileSync(MEMBERS_PATH, JSON.stringify(members, null, 2), 'utf-8');
}

function loadBoardMessages() {
  ensureDataDir();
  if (!existsSync(BOARD_PATH)) return [];
  try {
    const lines = readFileSync(BOARD_PATH, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const msgs = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && !Array.isArray(obj.to)) {
          obj.to = obj.to ? String(obj.to).split(',').map((s) => s.trim()).filter(Boolean) : ['all'];
        }
        msgs.push(obj);
      } catch {}
    }
    return msgs;
  } catch {
    return [];
  }
}

function appendBoardMessage(msg) {
  const existing = loadBoardMessages();
  const nextSeq = existing.length ? Math.max(...existing.map((m) => Number(m.seq) || 0)) + 1 : 1;
  const entry = {
    seq: nextSeq,
    ts: new Date().toISOString(),
    from: msg.from || 'coordinator',
    to: Array.isArray(msg.to) ? msg.to : msg.to ? [msg.to] : ['all'],
    role: msg.role || 'coordinator',
    type: msg.type || 'note',
    status: msg.status || '',
    model: msg.model || '',
    reasoningEffort: msg.reasoningEffort || '',
    sandbox: msg.sandbox || '',
    runtime: msg.runtime || '',
    workdir: msg.workdir || '',
    elapsedSec: msg.elapsedSec ?? null,
    ephemeral: msg.ephemeral ?? true,
    text: String(msg.text || '')
  };
  ensureDataDir();
  const line = JSON.stringify(entry) + '\n';
  if (existsSync(BOARD_PATH)) {
    writeFileSync(BOARD_PATH, readFileSync(BOARD_PATH, 'utf-8') + line, 'utf-8');
  } else {
    writeFileSync(BOARD_PATH, line, 'utf-8');
  }
  return entry;
}

function readLogTail(logFile, maxLines = 35) {
  if (!logFile || !existsSync(logFile)) return '';
  try {
    const buf = readFileSync(logFile);
    const isUtf16 =
      (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ||
      (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00);
    const content = buf.toString(isUtf16 ? 'utf16le' : 'utf8');
    const lines = content.split(/\r?\n/);
    return lines.slice(-maxLines).join('\n').trim();
  } catch {
    return '';
  }
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api(
  '/api/state',
  () => {
    const settings = loadSettings();
    const models = loadAvailableModels();
    const membersMap = loadMembers();
    const messages = loadBoardMessages();

    // Enrich working members with live log tail
    const membersList = Object.values(membersMap).map((m) => ({
      ...m,
      liveLog: m.logFile ? readLogTail(m.logFile, 40) : ''
    }));

    const htmlPath = join(__dirname, 'index.html');
    let htmlMtime = 0;
    try { htmlMtime = statSync(htmlPath).mtimeMs; } catch {}

    return {
      settings,
      models,
      members: membersList,
      messages,
      htmlMtime,
      serverTime: new Date().toISOString()
    };
  },
  'GET'
);

app.api(
  '/api/settings',
  (data) => {
    const updated = saveSettings(data || {});
    return { ok: true, settings: updated };
  },
  'POST'
);

app.api(
  '/api/board/post',
  (data) => {
    if (data.swarmTitle) {
      saveSettings({ swarmTitle: String(data.swarmTitle) });
    }
    const entry = appendBoardMessage(data || {});
    return { ok: true, entry };
  },
  'POST'
);

app.api(
  '/api/board/clear',
  () => {
    ensureDataDir();
    writeFileSync(BOARD_PATH, '', 'utf-8');
    saveMembers({});
    return { ok: true };
  },
  'POST'
);

// Built-in Stall Monitor (@monitor): zero-token background watchdog
const alertedStalls = new Set();
setInterval(() => {
  try {
    const settings = loadSettings();
    const timeoutMs = (Number(settings.stallTimeoutMin) || 8) * 60 * 1000;
    const membersMap = loadMembers();
    const now = Date.now();
    for (const m of Object.values(membersMap)) {
      if (!m || m.status !== 'working') continue;
      let lastActiveMs = m.startedAt ? Date.parse(m.startedAt) : 0;
      if (m.logFile && existsSync(m.logFile)) {
        try {
          const st = statSync(m.logFile);
          if (st.mtimeMs > lastActiveMs) lastActiveMs = st.mtimeMs;
        } catch {}
      }
      if (lastActiveMs > 0 && now - lastActiveMs > timeoutMs) {
        const key = `${m.name}|${m.startedAt}`;
        if (!alertedStalls.has(key)) {
          alertedStalls.add(key);
          const mins = Math.round((now - lastActiveMs) / 60000);
          appendBoardMessage({
            from: 'monitor',
            to: ['coordinator', m.name],
            role: 'monitor',
            type: 'stall',
            status: 'failed',
            text: `[stall] 巡检告警：子 Agent @${m.name} 已超过 ${mins} 分钟无新日志输出，可能遇到阻塞，请检查或重新派单。`
          });
        }
      }
    }
  } catch {}
}, 20000);

app.run();
