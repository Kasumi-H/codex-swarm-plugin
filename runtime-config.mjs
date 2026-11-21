import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtimeConfigName = 'runtime-config.json';

export function getDataDir(pluginRoot = fileURLToPath(new URL('.', import.meta.url))) {
  try {
    const { dataDir } = JSON.parse(readFileSync(join(pluginRoot, runtimeConfigName), 'utf8'));
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('Invalid runtime-config.json dataDir');
    return dataDir;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'codex-swarm');
  }
}
