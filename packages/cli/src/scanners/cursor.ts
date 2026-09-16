import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  accumulate,
  dateKey,
  emptyResult,
  finalize,
  initDateMap,
  normalizeModelName,
  resolveProjectFields,
  type ProjectFields,
} from './utils.js';

// ── 环境变量 ──

const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR';
const CURSOR_STATE_DB_PATH_ENV = 'CURSOR_STATE_DB_PATH';
const CURSOR_WEB_BASE_URL_ENV = 'CURSOR_WEB_BASE_URL';
const CURSOR_STATE_DB_RELATIVE = join('User', 'globalStorage', 'state.vscdb');
const CURSOR_SESSION_COOKIE = 'WorkosCursorSessionToken';
const PLACEHOLDER_PROJECTS = new Set(['', 'unknown', 'empty-window', 'New Project', 'workspace']);
const EMPTY_WINDOW = 'empty-window';
const EMPTY_WINDOW_FIELDS: ProjectFields = { project: EMPTY_WINDOW, projectDisplay: EMPTY_WINDOW };
const EMPTY_WINDOW_CHAT_ALIASES: Record<string, string> = {
  翻译助手: 'translation-assistant',
};

// ── 路径解析 ──

function getDefaultDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', CURSOR_STATE_DB_RELATIVE);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', CURSOR_STATE_DB_RELATIVE);
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdg, 'Cursor', CURSOR_STATE_DB_RELATIVE);
}

function findDbPath(): string | null {
  const explicit = process.env[CURSOR_STATE_DB_PATH_ENV]?.trim();
  if (explicit) {
    const p = resolve(explicit);
    return existsSync(p) ? p : null;
  }
  const dirs = process.env[CURSOR_CONFIG_DIR_ENV]?.trim();
  const candidates = dirs
    ? dirs.split(',').map(v => {
        const r = resolve(v.trim());
        return r.endsWith('.vscdb') ? r : join(r, CURSOR_STATE_DB_RELATIVE);
      })
    : [getDefaultDbPath()];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function cursorRootFromDb(dbPath: string): string {
  return resolve(dbPath, '..', '..', '..');
}

// ── SQLite 读取（使用 node:sqlite，Node 22+）──

interface AuthState {
  accessToken?: string;
}

async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  return DatabaseSync;
}

async function readAuthFromDb(dbPath: string): Promise<AuthState> {
  const DatabaseSync = await openSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    const row = stmt.get('cursorAuth/accessToken') as { value?: string | Buffer } | undefined;
    const raw = row?.value;
    let token: string | undefined;
    if (typeof raw === 'string') token = raw.trim() || undefined;
    else if (Buffer.isBuffer(raw)) token = raw.toString('utf8').trim() || undefined;
    return { accessToken: token };
  } finally {
    db.close();
  }
}

async function withSnapshot<T>(dbPath: string, cb: (snap: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aiusage-cursor-'));
  const snap = join(dir, 'state.vscdb');
  await copyFile(dbPath, snap);
  for (const suffix of ['-shm', '-wal']) {
    if (existsSync(`${dbPath}${suffix}`)) await copyFile(`${dbPath}${suffix}`, `${snap}${suffix}`);
  }
  try {
    return await cb(snap);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withDb<T>(dbPath: string, cb: (snap: string) => Promise<T>): Promise<T> {
  try {
    return await cb(dbPath);
  } catch (err) {
    if (err instanceof Error && /database is locked/i.test(err.message)) {
      return withSnapshot(dbPath, cb);
    }
    throw err;
  }
}

async function readAuth(dbPath: string): Promise<AuthState> {
  try {
    return await withDb(dbPath, snap => readAuthFromDb(snap));
  } catch {
    return {};
  }
}

// ── JWT sub 解析 ──

function jwtSub(token: string): string | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  try {
    return (JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { sub?: string }).sub?.trim();
  } catch {
    return undefined;
  }
}

// ── Cursor API ──

function getWebBaseUrl(): string {
  return (process.env[CURSOR_WEB_BASE_URL_ENV]?.trim() || 'https://cursor.com').replace(/\/+$/, '');
}

const BROWSER_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://cursor.com/settings',
  Origin: 'https://cursor.com',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export interface CursorUsageEvent {
  timestamp?: string | number;
  model?: string;
  conversationId?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  };
}

let usageCache: { token: string; events: CursorUsageEvent[]; at: number } | null = null;
const USAGE_CACHE_MS = 60_000;

function sessionHeaders(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
  const sub = jwtSub(accessToken);
  const cookie = `${CURSOR_SESSION_COOKIE}=${sub ? `${sub}::${accessToken}` : accessToken}`;
  return { ...BROWSER_HEADERS, Cookie: cookie, ...extra };
}

async function fetchCsv(accessToken: string): Promise<string> {
  const url = new URL('/api/dashboard/export-usage-events-csv?strategy=tokens', getWebBaseUrl());
  const cookie = sessionHeaders(accessToken);
  const attempts = [
    cookie,
    { Cookie: cookie.Cookie ?? '' },
    { Authorization: `Bearer ${accessToken}` },
  ];
  const failures: string[] = [];
  for (const headers of attempts) {
    const cleaned = Object.fromEntries(Object.entries(headers).filter(([, v]) => v));
    const res = await fetch(url, { headers: cleaned });
    if (!res.ok) {
      failures.push(`${res.status} ${res.statusText}`);
      continue;
    }
    const text = await res.text();
    if (text.startsWith('Date,') || text.startsWith('"Date"')) return text;
    failures.push(`unexpected body (${res.headers.get('content-type') ?? 'unknown'})`);
  }
  throw new Error(`Cursor API failed: ${failures.join(', ')}`);
}

async function fetchUsageEvents(accessToken: string): Promise<CursorUsageEvent[]> {
  const url = new URL('/api/dashboard/get-filtered-usage-events', getWebBaseUrl());
  const events: CursorUsageEvent[] = [];
  const pageSize = 1000;
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...sessionHeaders(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page, pageSize }),
    });
    if (!res.ok) throw new Error(`Cursor usage events failed: ${res.status} ${res.statusText}`);
    const json = await res.json() as {
      totalUsageEventsCount?: number;
      usageEventsDisplay?: CursorUsageEvent[];
    };
    const batch = Array.isArray(json.usageEventsDisplay) ? json.usageEventsDisplay : [];
    events.push(...batch);
    if (batch.length < pageSize || events.length >= (json.totalUsageEventsCount ?? 0)) break;
  }
  return events;
}

function parseCsvLine(line: string): string[] {
  const vals: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      vals.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  vals.push(cur);
  return vals;
}

function parseNum(v?: string | number): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  const n = Number((v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function parseDateStr(v?: string): string | null {
  const s = v?.trim().replace(/^"|"$/g, '');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return dateKey(d);
}

function eventWhen(event: CursorUsageEvent): Date | null {
  if (event.timestamp == null || event.timestamp === '') return null;
  if (typeof event.timestamp === 'number' || /^\d+(\.\d+)?$/.test(String(event.timestamp))) {
    const num = typeof event.timestamp === 'number' ? event.timestamp : Number(event.timestamp);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(event.timestamp).trim().replace(/^"|"$/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function col(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    if (row[name]) return row[name];
    const found = Object.keys(row).find(key => key.trim().toLowerCase() === name.toLowerCase());
    if (found && row[found]) return row[found];
  }
  return '';
}

function eventsFromCsv(text: string): CursorUsageEvent[] {
  const events: CursorUsageEvent[] = [];
  let headers: string[] | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    if (!headers) { headers = values; continue; }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    const date = parseDateStr(col(row, 'Date'));
    if (!date) continue;
    events.push({
      timestamp: col(row, 'Date'),
      model: col(row, 'Model').trim(),
      conversationId: col(row, 'Cloud Agent ID', 'Automation ID').trim() || undefined,
      tokenUsage: {
        inputTokens: parseNum(col(row, 'Input (w/o Cache Write)')),
        cacheWriteTokens: parseNum(col(row, 'Input (w/ Cache Write)')),
        cacheReadTokens: parseNum(col(row, 'Cache Read')),
        outputTokens: parseNum(col(row, 'Output Tokens')),
      },
    });
  }
  return events;
}

export async function loadCursorUsageEvents(): Promise<CursorUsageEvent[] | null> {
  const now = Date.now();
  if (usageCache && now - usageCache.at < USAGE_CACHE_MS) return usageCache.events;

  const dbPath = findDbPath();
  if (!dbPath) return null;

  const auth = await readAuth(dbPath);
  if (!auth.accessToken) return null;

  try {
    const events = await fetchUsageEvents(auth.accessToken);
    if (events.length) {
      usageCache = { token: auth.accessToken, events, at: now };
      return events;
    }
  } catch {
    // 用量 JSON 失败时退回 CSV（没有 conversationId，项目会落成 unknown）
  }

  try {
    const events = eventsFromCsv(await fetchCsv(auth.accessToken));
    usageCache = { token: auth.accessToken, events, at: now };
    return events;
  } catch {
    return null;
  }
}

// ── 项目归属 ──

export function isPlaceholderProjectName(name?: string | null): boolean {
  return PLACEHOLDER_PROJECTS.has((name ?? '').trim());
}

export function isEmptyWindowName(name?: string | null): boolean {
  const value = (name ?? '').trim();
  return value === EMPTY_WINDOW || basename(value) === EMPTY_WINDOW;
}

export function encodeCursorWorkspacePath(absPath: string): string {
  return absPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\//g, '-');
}

function pathFromUri(raw?: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    if (raw.startsWith('file://')) {
      try {
        return decodeURIComponent(raw.replace(/^file:\/\//, ''));
      } catch {
        return raw.replace(/^file:\/\//, '');
      }
    }
    return raw;
  }
  if (typeof raw === 'object') {
    const obj = raw as { fsPath?: string; path?: string; external?: string };
    return obj.fsPath || obj.path || pathFromUri(obj.external);
  }
  return undefined;
}

export function usableProjectPath(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value || isPlaceholderProjectName(value) || isPlaceholderProjectName(basename(value))) {
    return undefined;
  }
  return value;
}

export function nameFromEncodedCursorProject(
  encoded: string,
  knownEncodedToPath: Map<string, string>,
): string | undefined {
  if (isPlaceholderProjectName(encoded)) return undefined;
  const exact = knownEncodedToPath.get(encoded);
  if (exact) return usableProjectPath(exact);
  let best: { enc: string; path: string } | null = null;
  for (const [enc, path] of knownEncodedToPath) {
    if (encoded.startsWith(`${enc}-`) && (!best || enc.length > best.enc.length)) {
      best = { enc, path };
    }
  }
  if (!best) return undefined;
  const rest = encoded.slice(best.enc.length + 1);
  return usableProjectPath(rest) ?? usableProjectPath(best.path);
}

function rememberPath(target: Map<string, string>, raw?: string | null): void {
  const path = usableProjectPath(raw);
  if (!path) return;
  target.set(encodeCursorWorkspacePath(path), path);
}

function walkTranscriptIds(dir: string, encodedProject: string, out: Map<string, string>): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) || name.startsWith('bc-')) {
        out.set(name, encodedProject);
      }
      walkTranscriptIds(full, encodedProject, out);
    } else if (name.endsWith('.jsonl')) {
      out.set(name.replace(/\.jsonl$/, ''), encodedProject);
    }
  }
}

function readWorkspaceFolderMap(cursorRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const wsRoot = join(cursorRoot, 'User', 'workspaceStorage');
  if (!existsSync(wsRoot)) return map;
  for (const name of readdirSync(wsRoot)) {
    const file = join(wsRoot, name, 'workspace.json');
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { folder?: string };
      const folder = usableProjectPath(pathFromUri(raw.folder));
      if (folder) map.set(name, folder);
    } catch {
      // ignore malformed workspace metadata
    }
  }
  return map;
}

interface ComposerHeader {
  workspaceId?: string;
  workspacePath?: string;
  name?: string;
}

interface CloudAgent {
  bcId?: string;
  workspaceRootPath?: string;
  repoUrl?: string;
  repoUrls?: string[];
  name?: string;
}

function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readProjectTables(dbPath: string): Promise<{
  headers: Map<string, ComposerHeader>;
  membership: Record<string, string>;
  projects: Map<string, string>;
  cloud: Map<string, string>;
}> {
  const DatabaseSync = await openSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const headers = new Map<string, ComposerHeader>();
    for (const row of db.prepare('SELECT composerId, workspaceId, value FROM composerHeaders').all() as Array<{
      composerId?: string;
      workspaceId?: string;
      value?: string;
    }>) {
      const id = String(row.composerId ?? '').trim();
      if (!id) continue;
      const value = parseJson<{
        name?: unknown;
        workspaceIdentifier?: { id?: string; uri?: unknown };
        trackedGitRepos?: Array<{ repo?: string; url?: string } | string>;
      }>(row.value);
      const workspacePath = usableProjectPath(pathFromUri(value?.workspaceIdentifier?.uri))
        ?? usableProjectPath(pathFromUri((value?.trackedGitRepos ?? [])[0]));
      headers.set(id, {
        workspaceId: row.workspaceId ? String(row.workspaceId) : undefined,
        workspacePath,
        name: typeof value?.name === 'string' ? value.name.trim() || undefined : undefined,
      });
    }

    const membership = parseJson<Record<string, string>>(
      (db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('glass.localAgentProjectMembership.v1') as { value?: unknown } | undefined)?.value,
    ) ?? {};

    const projectRows = parseJson<Array<{ id?: string; name?: string; workspace?: { uri?: unknown } }>>(
      (db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('glass.localAgentProjects.v1') as { value?: unknown } | undefined)?.value,
    ) ?? [];
    const projects = new Map<string, string>();
    for (const project of projectRows) {
      if (!project.id) continue;
      const path = usableProjectPath(pathFromUri(project.workspace?.uri)) ?? usableProjectPath(project.name);
      if (path) projects.set(project.id, path);
    }

    const extra = parseJson<Array<{ name?: string; workspaceIdentifier?: { uri?: unknown } }>>(
      (db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('cursor/glass.additionalProjects') as { value?: unknown } | undefined)?.value,
    ) ?? [];
    for (const item of extra) {
      const path = usableProjectPath(pathFromUri(item.workspaceIdentifier?.uri)) ?? usableProjectPath(item.name);
      if (path && item.name) projects.set(item.name, path);
    }

    const cloud = new Map<string, string>();
    for (const row of db.prepare("SELECT value FROM ItemTable WHERE key LIKE 'cloudAgentRepository.agents.%'").all() as Array<{ value?: unknown }>) {
      const agents = parseJson<CloudAgent[]>(row.value) ?? [];
      for (const agent of agents) {
        if (!agent.bcId) continue;
        const repo = agent.repoUrl || agent.repoUrls?.[0] || '';
        const path = usableProjectPath(repo.split('/').filter(Boolean).pop())
          ?? usableProjectPath(agent.workspaceRootPath)
          ?? usableProjectPath(agent.name);
        if (path) cloud.set(agent.bcId, path);
      }
    }

    return { headers, membership, projects, cloud };
  } finally {
    db.close();
  }
}

export function resolveEmptyWindowChatName(name?: string | null): string | undefined {
  const raw = (name ?? '').trim();
  if (!raw || isPlaceholderProjectName(raw) || isEmptyWindowName(raw)) {
    return undefined;
  }
  const named = (EMPTY_WINDOW_CHAT_ALIASES[raw] ?? raw).replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim();
  if (!named || isPlaceholderProjectName(named) || isEmptyWindowName(named)) return undefined;
  return named;
}

export function rewriteLegacyProjectPath(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (isEmptyWindowName(value)) return EMPTY_WINDOW;
  const mapped = EMPTY_WINDOW_CHAT_ALIASES[basename(value)];
  if (!mapped) return usableProjectPath(value);
  if (basename(value) === value) return mapped;
  return join(dirname(value), mapped);
}

export function resolveCursorConversationProject(
  conversationId: string | undefined,
  index: CursorProjectIndex,
): ProjectFields {
  if (!conversationId) return { project: 'unknown', projectDisplay: 'unknown' };
  const path = rewriteLegacyProjectPath(index.conversationToPath.get(conversationId));
  if (!path) return { project: 'unknown', projectDisplay: 'unknown' };
  if (isEmptyWindowName(path)) return resolveEmptyWindowProject(conversationId, index);
  return resolveProjectFields(path, index.aliases);
}

function resolveEmptyWindowProject(
  conversationId: string,
  index: CursorProjectIndex,
): ProjectFields {
  const named = resolveEmptyWindowChatName(index.conversationNames?.get(conversationId));
  if (!named) return EMPTY_WINDOW_FIELDS;
  const folder = index.namedFolders?.get(named);
  if (folder) return resolveProjectFields(folder, index.aliases);
  return { project: named, projectDisplay: named };
}

export interface CursorProjectIndex {
  conversationToPath: Map<string, string>;
  conversationNames?: Map<string, string>;
  namedFolders?: Map<string, string>;
  aliases?: Record<string, string>;
}

function collectNamedFolders(home: string, knownEncoded: Map<string, string>): Map<string, string> {
  const namedFolders = new Map<string, string>();
  const remember = (raw?: string | null) => {
    const path = usableProjectPath(raw);
    if (!path) return;
    namedFolders.set(basename(path), path);
  };
  for (const path of knownEncoded.values()) remember(path);
  const documents = join(home, 'Documents');
  if (!existsSync(documents)) return namedFolders;
  try {
    for (const name of readdirSync(documents)) {
      const full = join(documents, name);
      try {
        if (statSync(full).isDirectory()) remember(full);
      } catch {
        // ignore unreadable entries
      }
    }
  } catch {
    // ignore unreadable Documents
  }
  return namedFolders;
}

export async function buildCursorProjectIndex(
  dbPath = findDbPath(),
  home = homedir(),
): Promise<CursorProjectIndex> {
  const conversationToPath = new Map<string, string>();
  const conversationNames = new Map<string, string>();
  if (!dbPath) return { conversationToPath, conversationNames };

  const knownEncoded = new Map<string, string>();
  const workspaceFolders = readWorkspaceFolderMap(cursorRootFromDb(dbPath));
  for (const folder of workspaceFolders.values()) rememberPath(knownEncoded, folder);

  let tables: Awaited<ReturnType<typeof readProjectTables>>;
  try {
    tables = await withDb(dbPath, snap => readProjectTables(snap));
  } catch {
    return { conversationToPath, conversationNames };
  }

  for (const path of tables.projects.values()) rememberPath(knownEncoded, path);
  for (const path of tables.cloud.values()) rememberPath(knownEncoded, path);
  for (const header of tables.headers.values()) rememberPath(knownEncoded, header.workspacePath);
  for (const path of collectNamedFolders(home, knownEncoded).values()) rememberPath(knownEncoded, path);

  const assign = (id: string | undefined, raw?: string | null) => {
    if (!id || conversationToPath.has(id)) return;
    if (isEmptyWindowName(raw)) {
      conversationToPath.set(id, EMPTY_WINDOW);
      return;
    }
    const path = rewriteLegacyProjectPath(raw);
    if (!path) return;
    conversationToPath.set(id, path);
  };

  for (const [id, header] of tables.headers) {
    if (header.name) conversationNames.set(id, header.name);
    assign(id, header.workspacePath);
    assign(id, header.workspaceId ? workspaceFolders.get(header.workspaceId) : undefined);
    if (header.workspaceId === EMPTY_WINDOW) assign(id, EMPTY_WINDOW);
  }
  for (const [id, projectId] of Object.entries(tables.membership)) {
    assign(id, tables.projects.get(projectId));
  }
  for (const [id, path] of tables.cloud) assign(id, path);

  const transcriptToEncoded = new Map<string, string>();
  const projectsRoot = join(home, '.cursor', 'projects');
  if (existsSync(projectsRoot)) {
    for (const encoded of readdirSync(projectsRoot)) {
      walkTranscriptIds(join(projectsRoot, encoded, 'agent-transcripts'), encoded, transcriptToEncoded);
    }
  }
  for (const [id, encoded] of transcriptToEncoded) {
    if (encoded === EMPTY_WINDOW) assign(id, EMPTY_WINDOW);
    else assign(id, nameFromEncodedCursorProject(encoded, knownEncoded));
  }

  return {
    conversationToPath,
    conversationNames,
    namedFolders: collectNamedFolders(home, knownEncoded),
  };
}

function eventDate(event: CursorUsageEvent): string | null {
  if (event.timestamp == null || event.timestamp === '') return null;
  if (typeof event.timestamp === 'number' || /^\d+(\.\d+)?$/.test(String(event.timestamp))) {
    const num = typeof event.timestamp === 'number' ? event.timestamp : Number(event.timestamp);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : dateKey(d);
  }
  return parseDateStr(String(event.timestamp));
}

export function groupCursorUsageEvents(
  events: CursorUsageEvent[],
  targetDates: string[],
  index: CursorProjectIndex,
): Map<string, IngestBreakdown[]> {
  const dateSet = new Set(targetDates);
  if (!events.length) return emptyResult(dateSet);
  const grouped = initDateMap(dateSet);

  for (const event of events) {
    const date = eventDate(event);
    if (!date || !dateSet.has(date)) continue;
    const rawModel = event.model?.trim();
    if (!rawModel) continue;
    const model = normalizeModelName(rawModel);
    const tu = event.tokenUsage ?? {};
    const tokens = {
      input: parseNum(tu.inputTokens),
      cached: parseNum(tu.cacheReadTokens),
      cacheWrite: parseNum(tu.cacheWriteTokens),
      output: parseNum(tu.outputTokens),
      reasoning: 0,
    };
    if (tokens.input + tokens.cached + tokens.cacheWrite + tokens.output === 0) continue;

    const project = resolveCursorConversationProject(event.conversationId, index);
    accumulate(grouped.get(date)!, `${model}|${project.project}`, {
      provider: 'cursor',
      product: 'cursor',
      channel: 'ide',
      model,
      project: project.project,
      projectDisplay: project.projectDisplay,
      projectAlias: project.projectAlias,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    }, tokens, 1, eventWhen(event) ?? undefined);
  }

  return finalize(grouped);
}

// ── 主入口 ──

export async function isCursorAvailable(): Promise<boolean> {
  const dbPath = findDbPath();
  if (!dbPath) return false;
  try {
    const auth = await readAuth(dbPath);
    return Boolean(auth.accessToken);
  } catch {
    return false;
  }
}

export async function scanCursor(targetDate: string): Promise<IngestBreakdown[]> {
  return (await scanCursorDates([targetDate])).get(targetDate) ?? [];
}

export async function discoverCursorDates(): Promise<string[]> {
  const events = await loadCursorUsageEvents();
  if (!events) return [];
  const dates = new Set<string>();
  for (const event of events) {
    const date = eventDate(event);
    if (date) dates.add(date);
  }
  return [...dates];
}

export async function scanCursorDates(
  targetDates: string[],
  options: { projectAliases?: Record<string, string> } = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const events = await loadCursorUsageEvents();
  if (!events) return emptyResult(new Set(targetDates));
  const index = await buildCursorProjectIndex();
  index.aliases = options.projectAliases;
  return groupCursorUsageEvents(events, targetDates, index);
}
