#!/usr/bin/env node
/**
 * Codex Swarm — One-Click Cross-Platform Installer (macOS / Linux / Windows)
 *
 * Usage:
 *   macOS / Linux : bash install.sh   (or: node install.mjs)
 *   Windows       : powershell -ExecutionPolicy Bypass -File .\install.ps1   (or: node install.mjs)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const home = os.homedir();
const targetPluginDir = path.join(home, '.gemini', 'config', 'plugins', 'codex-swarm');
const targetDataDir = path.join(home, '.gemini', 'antigravity', 'plugin_data', 'codex-swarm');

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (child === '.git' || child === 'node_modules') continue;
      copyRecursiveSync(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('==========================================================');
console.log('  Codex Swarm Plugin — Cross-Platform One-Click Installer ');
console.log(`  OS Platform : ${process.platform} (${os.arch()})`);
console.log(`  Source Dir  : ${__dirname}`);
console.log(`  Target Dir  : ${targetPluginDir}`);
console.log('==========================================================');

// 1. Copy files if installing from an external repository folder
if (path.resolve(__dirname) !== path.resolve(targetPluginDir)) {
  copyRecursiveSync(__dirname, targetPluginDir);
  console.log('[1/4] Copied plugin bundle to ~/.gemini/config/plugins/codex-swarm');
} else {
  console.log('[1/4] Running in-place inside ~/.gemini/config/plugins/codex-swarm');
}

// 2. Write OS-resolved mcp_config.json
const mcpServerPath = path.join(targetPluginDir, 'mcp', 'codex-mcp-server.mjs');
const mcpConfig = {
  mcpServers: {
    'codex-swarm-mcp': {
      command: 'node',
      args: [mcpServerPath]
    }
  }
};
fs.writeFileSync(
  path.join(targetPluginDir, 'mcp_config.json'),
  JSON.stringify(mcpConfig, null, 2) + '\n',
  'utf8'
);
console.log('[2/4] Configured mcp_config.json for current OS path');

// 3. Ensure executable permissions on macOS / Linux
if (process.platform !== 'win32') {
  for (const rel of [
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
console.log('[3/4] Verified script permissions');

// 4. Initialize plugin_data directory & default settings.json
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
console.log('[4/4] Initialized plugin_data/codex-swarm settings');

console.log('\n✅ Codex Swarm installed successfully!');
console.log('   - Trigger in chat : Type /codex-swarm followed by your task');
console.log('   - Open right pane : Click "Codex Swarm" under Plugins in the right-hand side pane');
