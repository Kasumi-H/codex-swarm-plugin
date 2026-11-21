#!/usr/bin/env node
/**
 * Codex Swarm — One-Click Cross-Platform Installer (macOS / Linux / Windows)
 *
 * Usage:
 *   macOS / Linux : bash install.sh   (or: node install.mjs)
 *   Windows       : powershell -ExecutionPolicy Bypass -File .\install.ps1   (or: node install.mjs)
 *
 * Optional flags:
 *   --dry-run                Preview install actions without writing files
 *   --target-dir <path>      Override plugin install directory
 *   --data-dir <path>        Override plugin_data directory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir, runtimeConfigName } from './runtime-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCliArgs(argv) {
  const res = { dryRun: false, targetDir: '', dataDir: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') res.dryRun = true;
    else if (a === '--help' || a === '-h') res.help = true;
    else if (a === '--target-dir' && i + 1 < argv.length) res.targetDir = argv[++i];
    else if (a === '--data-dir' && i + 1 < argv.length) res.dataDir = argv[++i];
  }
  return res;
}

const cli = parseCliArgs(process.argv.slice(2));
if (cli.help) {
  console.log('Usage: node install.mjs [--dry-run] [--target-dir <dir>] [--data-dir <dir>]');
  process.exit(0);
}

const home = os.homedir();
const targetPluginDir = path.resolve(
  cli.targetDir || path.join(home, '.gemini', 'config', 'plugins', 'codex-swarm')
);
const targetDataDir = path.resolve(
  cli.dataDir || getDataDir(targetPluginDir)
);
const nodeCommand = process.execPath || 'node';

const SKIP_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store', runtimeConfigName]);

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (SKIP_ENTRIES.has(child)) continue;
      copyRecursiveSync(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function buildExtraPaths() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = [];
  const addDir = (d) => {
    if (d && !dirs.includes(d) && fs.existsSync(d)) dirs.push(d);
  };

  addDir(path.dirname(nodeCommand));

  if (process.platform === 'win32') {
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
      path.join(home, '.fnm', 'aliases', 'default', 'bin')
    ]) {
      addDir(d);
    }
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        if (versions.length) addDir(path.join(nvmDir, versions[0], 'bin'));
      } catch {}
    }
  }

  for (const existing of (process.env.PATH || '').split(sep)) {
    if (existing && !dirs.includes(existing)) dirs.push(existing);
  }
  return dirs.join(sep);
}

console.log('==========================================================');
console.log('  Codex Swarm Plugin — Cross-Platform One-Click Installer ');
console.log(`  OS Platform : ${process.platform} (${os.arch()})`);
console.log(`  Node Binary : ${nodeCommand}`);
console.log(`  Source Dir  : ${__dirname}`);
console.log(`  Target Dir  : ${targetPluginDir}`);
console.log(`  Data Dir    : ${targetDataDir}`);
if (cli.dryRun) {
  console.log('  Mode        : DRY RUN (no files will be modified)');
}
console.log('==========================================================');

// 1. Copy files if installing from an external repository folder
if (path.resolve(__dirname) !== targetPluginDir) {
  if (!cli.dryRun) {
    copyRecursiveSync(__dirname, targetPluginDir);
  }
  console.log(`[1/5] ${cli.dryRun ? '[dry-run] Would copy' : 'Copied'} plugin bundle to ${targetPluginDir}`);
} else {
  console.log(`[1/5] Running in-place inside ${targetPluginDir}`);
}

// 2. Write OS-resolved mcp_config.json (using absolute node binary path for macOS GUI compatibility)
const mcpServerPath = path.join(targetPluginDir, 'mcp', 'codex-mcp-server.mjs');
const enhancedPath = buildExtraPaths();
const mcpConfig = {
  mcpServers: {
    'codex-swarm-mcp': {
      command: nodeCommand,
      args: [mcpServerPath],
      ...(process.platform !== 'win32' ? { env: { PATH: enhancedPath } } : {})
    }
  }
};
if (!cli.dryRun) {
  fs.writeFileSync(
    path.join(targetPluginDir, 'mcp_config.json'),
    JSON.stringify(mcpConfig, null, 2) + '\n',
    'utf8'
  );
}
console.log(`[2/5] ${cli.dryRun ? '[dry-run] Would configure' : 'Configured'} mcp_config.json with resolved Node path`);

// 3. Patch installed sidecar.json with resolved absolute node binary path (prevents macOS GUI PATH ENOENT)
const installedSidecarJsonPath = path.join(targetPluginDir, 'sidecars', 'codex_board', 'sidecar.json');
if (!cli.dryRun && fs.existsSync(installedSidecarJsonPath)) {
  try {
    const sidecarCfg = JSON.parse(fs.readFileSync(installedSidecarJsonPath, 'utf8'));
    sidecarCfg.command = nodeCommand;
    fs.writeFileSync(installedSidecarJsonPath, JSON.stringify(sidecarCfg, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn(`[3/5] Warning: could not update sidecar.json command: ${String(err)}`);
  }
}
console.log(`[3/5] ${cli.dryRun ? '[dry-run] Would configure' : 'Configured'} sidecar.json with resolved Node path`);

// 4. Ensure executable permissions on macOS / Linux
if (process.platform !== 'win32' && !cli.dryRun) {
  for (const rel of [
    ['install.sh'],
    ['install.mjs'],
    ['mcp', 'codex-mcp-server.mjs'],
    ['skills', 'codex-swarm', 'scripts', 'codex-worker.mjs'],
    ['sidecars', 'codex_board', 'main.mjs']
  ]) {
    const f = path.join(targetPluginDir, ...rel);
    if (fs.existsSync(f)) {
      try { fs.chmodSync(f, 0o755); } catch {}
    }
  }
}
console.log(`[4/5] ${cli.dryRun ? '[dry-run] Would verify' : 'Verified'} script permissions`);

// 5. Initialize plugin_data directory & default settings.json
if (!cli.dryRun) {
  if (!fs.existsSync(targetDataDir)) {
    fs.mkdirSync(targetDataDir, { recursive: true });
  }
  const settingsPath = path.join(targetDataDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    const defaultSettings = {
      swarmTitle: 'Codex Swarm 协作看板 (就绪)',
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
        { name: 'architect', role: 'worker', model: 'gpt-6.2-sol', reasoningEffort: 'high', sandbox: 'read-only', desc: '架构分析、接口设计与复杂问题排查' },
        { name: 'coder', role: 'worker', model: 'gpt-6.1-terra', reasoningEffort: 'high', sandbox: 'workspace-write', desc: '主力业务代码实现、重构与单测编写' },
        { name: 'fast-worker', role: 'worker', model: 'gpt-6.1-terra', reasoningEffort: 'medium', sandbox: 'workspace-write', desc: '轻量级模块修改、脚本与文档整理' },
        { name: 'verifier', role: 'verifier', model: 'gpt-6.2-sol', reasoningEffort: 'high', sandbox: 'read-only', desc: '独立代码审查官 (codex review / 验收测试)' }
      ]
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2) + '\n', 'utf8');
  }
  fs.writeFileSync(
    path.join(targetPluginDir, runtimeConfigName),
    JSON.stringify({ dataDir: targetDataDir }, null, 2) + '\n',
    'utf8'
  );
}
console.log(`[5/5] ${cli.dryRun ? '[dry-run] Would initialize' : 'Initialized'} plugin_data/codex-swarm settings`);

console.log(`\n${cli.dryRun ? 'Dry run complete — no changes written.' : '✅ Codex Swarm installed successfully!'}`);
console.log('   - Trigger in chat : Type /codex-swarm followed by your task');
console.log('   - Open right pane : Click "Codex Swarm" under Plugins in the right-hand side pane');
