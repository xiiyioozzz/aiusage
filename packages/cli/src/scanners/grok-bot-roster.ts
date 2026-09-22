import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GROK_BOT_SUBAGENT_PROJECT = 'grok-bot-subagent';
export const GROK_BOT_PROJECT_PREFIX = 'grok-bot/';

interface RosterCache {
  version: 1;
  bots: Record<string, string>;
}

export function grokBotPersistenceDir(home = homedir()): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(home, 'AppData', 'Roaming');
    return join(appData, 'Grok Bot', 'sand-client-persistence');
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(xdg, 'Grok Bot', 'sand-client-persistence');
}

export function grokBotRosterCachePath(home = homedir()): string {
  return join(home, '.aiusage', 'grok-bot-roster.json');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32Key(stem: string): string | undefined {
  const compact = stem.replace(/=+$/, '').toUpperCase();
  if (!compact || /[^A-Z2-7]/.test(compact)) return undefined;
  let bits = '';
  for (const char of compact) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) return undefined;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBlobKey(filename: string): string | undefined {
  return decodeBase32Key(filename.replace(/\.blob$/i, ''));
}

function isRosterKey(key: string): boolean {
  return key.includes('.roster.last-roster') || key.endsWith('.roster');
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(row => row && typeof row === 'object') as Array<Record<string, unknown>>;
  if (value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows)) {
    return ((value as { rows: unknown[] }).rows).filter(row => row && typeof row === 'object') as Array<Record<string, unknown>>;
  }
  return [];
}

export function parseGrokBotRosterBlob(raw: string): Map<string, string> {
  const bots = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bots;
  }
  const value = parsed && typeof parsed === 'object' && 'value' in parsed
    ? (parsed as { value: unknown }).value
    : parsed;
  for (const row of asRows(value)) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    bots.set(id, name || title || `Grok Bot ${id.slice(0, 8)}`);
  }
  return bots;
}

export function readGrokBotRosterFromDisk(persistenceDir = grokBotPersistenceDir()): Map<string, string> {
  const bots = new Map<string, string>();
  if (!existsSync(persistenceDir)) return bots;
  let names: string[] = [];
  try {
    names = readdirSync(persistenceDir);
  } catch {
    return bots;
  }
  for (const name of names) {
    if (!name.endsWith('.blob')) continue;
    const key = decodeBlobKey(name);
    if (!key || !isRosterKey(key)) continue;
    try {
      const parsed = parseGrokBotRosterBlob(readFileSync(join(persistenceDir, name), 'utf8'));
      for (const [id, label] of parsed) bots.set(id, label);
    } catch {
      // ignore unreadable roster slices
    }
  }
  return bots;
}

function readRosterCache(path: string): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RosterCache;
    if (parsed.version !== 1 || !parsed.bots || typeof parsed.bots !== 'object') return new Map();
    const bots = new Map<string, string>();
    for (const [id, name] of Object.entries(parsed.bots)) {
      if (id.trim() && typeof name === 'string' && name.trim()) bots.set(id.trim(), name.trim());
    }
    return bots;
  } catch {
    return new Map();
  }
}

export async function writeGrokBotRosterCache(path: string, bots: Map<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload: RosterCache = { version: 1, bots: Object.fromEntries(bots) };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function loadGrokBotRoster(home = homedir()): Promise<Map<string, string>> {
  const bots = readRosterCache(grokBotRosterCachePath(home));
  for (const [id, name] of readGrokBotRosterFromDisk(grokBotPersistenceDir(home))) {
    bots.set(id, name);
  }
  await writeGrokBotRosterCache(grokBotRosterCachePath(home), bots);
  return bots;
}

export function grokBotProjectId(conversationId: string): string {
  return `${GROK_BOT_PROJECT_PREFIX}${conversationId}`;
}

export function grokBotDisplayName(id: string, name: string, roster: Map<string, string>): string {
  const label = name.trim() || `Grok Bot ${id.slice(0, 8)}`;
  const collisions = [...roster.values()].filter(value => value.trim() === label).length;
  return collisions > 1 ? `${label} · ${id.slice(0, 8)}` : label;
}

export function resolveGrokBotProject(
  conversationId: string | undefined,
  roster: Map<string, string> = new Map(),
): { project: string; projectDisplay: string } {
  const id = conversationId?.trim() ?? '';
  if (id.startsWith('sand-subagent-')) {
    return { project: GROK_BOT_SUBAGENT_PROJECT, projectDisplay: GROK_BOT_SUBAGENT_PROJECT };
  }
  if (!id) {
    return { project: 'grok-bot', projectDisplay: 'Grok Bot' };
  }
  const named = roster.get(id);
  const display = named
    ? grokBotDisplayName(id, named, roster)
    : `Grok Bot · ${id.slice(0, 8)}`;
  return { project: grokBotProjectId(id), projectDisplay: display };
}

