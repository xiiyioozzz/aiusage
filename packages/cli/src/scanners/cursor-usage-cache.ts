import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CursorUsageEvent } from './cursor.js';

type UsageSource = 'json' | 'csv';
interface AccountUsage {
  json: CursorUsageEvent[];
  csv: CursorUsageEvent[];
}
interface UsageArchive {
  version: 1;
  accounts: Record<string, AccountUsage>;
}

// Persist billing metadata only: never authentication, prompts or response text.
export function cursorAccountKey(subject: string, origin: string): string {
  return createHash('sha256').update(`${origin}\0${subject}`).digest('hex');
}

function sanitize(events: CursorUsageEvent[]): CursorUsageEvent[] {
  const result: CursorUsageEvent[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.model !== 'string' || !event.model.trim()) continue;
    const raw = event.timestamp;
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    const numeric = Number(raw);
    const timestamp = Number.isFinite(numeric) && raw !== ''
      ? (numeric < 1e12 ? numeric * 1000 : numeric)
      : Date.parse(String(raw));
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const tokens: NonNullable<CursorUsageEvent['tokenUsage']> = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'] as const) {
      const value = event.tokenUsage?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) tokens[key] = Math.round(value);
    }
    result.push({
      timestamp,
      model: event.model.trim(),
      ...(typeof event.conversationId === 'string' && event.conversationId ? { conversationId: event.conversationId } : {}),
      tokenUsage: tokens,
    });
  }
  return result;
}

// Dashboard events have no documented stable request ID. Preserve multiplicity
// within a snapshot, but do not count the same immutable event again on refresh.
function mergeEvents(previous: CursorUsageEvent[], incoming: CursorUsageEvent[]): CursorUsageEvent[] {
  const rows = new Map<string, CursorUsageEvent[]>();
  for (const batch of [sanitize(previous), sanitize(incoming)]) {
    const counts = new Map<string, CursorUsageEvent[]>();
    for (const event of batch) {
      const key = JSON.stringify(event);
      const group = counts.get(key) ?? [];
      group.push(event);
      counts.set(key, group);
    }
    for (const [key, group] of counts) if (group.length > (rows.get(key)?.length ?? 0)) rows.set(key, group);
  }
  return [...rows.values()].flat();
}

async function readArchive(path: string): Promise<UsageArchive> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as UsageArchive;
    if (parsed.version !== 1 || !parsed.accounts || typeof parsed.accounts !== 'object') throw new Error('Invalid archive');
    const accounts: Record<string, AccountUsage> = {};
    for (const [key, account] of Object.entries(parsed.accounts)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !account || !Array.isArray(account.json) || !Array.isArray(account.csv)) continue;
      accounts[key] = { json: sanitize(account.json), csv: sanitize(account.csv) };
    }
    return { version: 1, accounts };
  } catch {
    return { version: 1, accounts: {} };
  }
}

function archivedEvents(archive: UsageArchive): CursorUsageEvent[] {
  return Object.values(archive.accounts).flatMap((account) => {
    // CSV lacks conversation IDs. Prefer the JSON snapshot on overlapping UTC
    // dates so a temporary JSON API failure cannot double count an entire day.
    const jsonDates = new Set(account.json.map((event) => new Date(Number(event.timestamp)).toISOString().slice(0, 10)));
    return [...account.json, ...account.csv.filter((event) => !jsonDates.has(new Date(Number(event.timestamp)).toISOString().slice(0, 10)))];
  });
}

export async function readCursorUsageArchive(path: string): Promise<CursorUsageEvent[]> {
  return archivedEvents(await readArchive(path));
}

export async function readCursorProjectPaths(path: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { version?: number; paths?: unknown };
    if (parsed.version !== 1 || !parsed.paths || typeof parsed.paths !== 'object') return {};
    const paths: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed.paths as Record<string, unknown>)) {
      if (!id.trim() || typeof value !== 'string' || !value.trim() || value === 'unknown') continue;
      paths[id] = value;
    }
    return paths;
  } catch {
    return {};
  }
}

export async function writeCursorProjectPaths(path: string, paths: Record<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const clean: Record<string, string> = {};
  for (const [id, value] of Object.entries(paths)) {
    if (!id.trim() || !value.trim() || value === 'unknown') continue;
    clean[id] = value;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, paths: clean }), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function archiveCursorUsage(
  path: string,
  accountKey: string,
  source: UsageSource,
  events: CursorUsageEvent[],
): Promise<CursorUsageEvent[]> {
  if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new Error('Invalid Cursor account key');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  // Avoid overwriting another CLI process's just-written account history.
  let locked = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await mkdir(lock); locked = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!locked) throw new Error('Cursor usage archive is busy');
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const archive = await readArchive(path);
    const account = archive.accounts[accountKey] ?? { json: [], csv: [] };
    account[source] = mergeEvents(account[source], events);
    archive.accounts[accountKey] = account;
    await writeFile(temp, JSON.stringify(archive), { mode: 0o600 });
    await rename(temp, path);
    return archivedEvents(archive);
  } finally {
    await rm(temp, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
