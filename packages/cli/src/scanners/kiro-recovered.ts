import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  accumulate,
  dateKey,
  emptyResult,
  finalize,
  inferProviderFromModel,
  initDateMap,
  resolveProjectFields,
} from './utils.js';
import { normalizeProxyModel, resolveKiroProxyDataDirs } from './kiro-proxy.js';

/**
 * Recover Kiro-Go usage that never landed in request_logs.json:
 *   1. Hermes sessions billed to local Kiro-Go (:8080 / kiro-go-local)
 *   2. The leftover lifetime counter in Kiro-Go config.json, spread evenly
 *      across every day that already has kiro-go Hermes usage
 */

const HERMES_DB = 'state.db';
const KIRO_GO_PROJECT = 'kiro-go';

export interface KiroRecoveredScanOptions {
  extraDirs?: readonly string[];
  hermesDbPath?: string;
  home?: string;
  env?: NodeJS.Dict<string>;
  projectAliases?: Record<string, string>;
}

interface HermesUsageRow {
  when: Date;
  model: string;
  events: number;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
}

interface LifetimeSnapshot {
  totalTokens: number;
  totalRequests: number;
}

interface ModelShare {
  model: string;
  tokens: number;
  events: number;
}

export function resolveHermesDbPath(
  explicit?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string {
  const fromEnv = env.HERMES_STATE_DB?.trim() || env.KIRO_HERMES_DB?.trim();
  const raw = explicit?.trim() || fromEnv || join(home, '.hermes', HERMES_DB);
  return resolve(isAbsolute(raw) ? raw : join(home, raw));
}

export async function discoverKiroRecoveredDates(
  extraDirs: readonly string[] = [],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
  hermesDbPath?: string,
): Promise<Set<string>> {
  const dates = new Set<string>();
  for (const row of await loadHermesUsage(resolveHermesDbPath(hermesDbPath, home, env))) {
    dates.add(dateKey(row.when));
  }
  return dates;
}

export async function scanKiroRecoveredDates(
  targetDates: string[],
  options: KiroRecoveredScanOptions = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  if (dates.size === 0) return new Map();

  const grouped = initDateMap(dates);
  const hermesRows = await loadHermesUsage(
    resolveHermesDbPath(options.hermesDbPath, options.home, options.env),
  );
  addHermesRows(grouped, dates, hermesRows, options.projectAliases);

  const lifetime = await loadLifetimeSnapshot(options.extraDirs, options.home, options.env);
  if (lifetime) {
    addLifetimeRemainder(grouped, dates, lifetime, hermesRows, options.projectAliases);
  }

  return finalize(grouped);
}

function addHermesRows(
  grouped: ReturnType<typeof initDateMap>,
  dates: Set<string>,
  rows: HermesUsageRow[],
  projectAliases?: Record<string, string>,
): void {
  const projectFields = resolveProjectFields(KIRO_GO_PROJECT, projectAliases);
  for (const row of rows) {
    const usageDate = dateKey(row.when);
    if (!dates.has(usageDate)) continue;
    const day = grouped.get(usageDate);
    if (!day) continue;
    const model = normalizeProxyModel(row.model);
    const provider = inferProviderFromModel(model, 'kiro');
    accumulate(day, `api|hermes|${model}|${projectFields.project}`, {
      provider,
      product: 'kiro',
      channel: 'api',
      model,
      project: projectFields.project,
      projectDisplay: projectFields.projectDisplay,
      projectAlias: projectFields.projectAlias,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    }, {
      input: row.input,
      cached: row.cached,
      cacheWrite: row.cacheWrite,
      output: row.output,
      reasoning: row.reasoning,
    }, row.events);
  }
}

function addLifetimeRemainder(
  grouped: ReturnType<typeof initDateMap>,
  dates: Set<string>,
  lifetime: LifetimeSnapshot,
  hermesRows: HermesUsageRow[],
  projectAliases?: Record<string, string>,
): void {
  const countedTokens = hermesRows.reduce((sum, row) => sum + rowTokens(row), 0);
  const countedEvents = hermesRows.reduce((sum, row) => sum + row.events, 0);
  const leftoverTokens = Math.max(0, lifetime.totalTokens - countedTokens);
  const leftoverEvents = Math.max(0, lifetime.totalRequests - countedEvents);
  if (leftoverTokens <= 0) return;

  const byDay = groupHermesByDay(hermesRows);
  const kiroGoDays = [...byDay.keys()].sort();
  if (kiroGoDays.length === 0) return;

  const tokenShares = splitEvenly(leftoverTokens, kiroGoDays.length);
  const eventShares = splitEvenly(leftoverEvents, kiroGoDays.length);
  const projectFields = resolveProjectFields(KIRO_GO_PROJECT, projectAliases);

  for (const [index, usageDate] of kiroGoDays.entries()) {
    if (!dates.has(usageDate)) continue;
    const day = grouped.get(usageDate);
    if (!day) continue;
    const shares = sharesFromHermes(byDay.get(usageDate) ?? []);
    const parts = splitByShare(tokenShares[index] ?? 0, eventShares[index] ?? 0, shares);
    for (const part of parts) {
      if (part.tokens <= 0 && part.events <= 0) continue;
      const model = normalizeProxyModel(part.model);
      const key = `api|hermes|${model}|${projectFields.project}`;
      const existing = day.get(key);
      if (existing) {
        existing.inputTokens += part.tokens;
        existing.eventCount += part.events;
        continue;
      }
      const provider = inferProviderFromModel(model, 'kiro');
      accumulate(day, key, {
        provider,
        product: 'kiro',
        channel: 'api',
        model,
        project: projectFields.project,
        projectDisplay: projectFields.projectDisplay,
        projectAlias: projectFields.projectAlias,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      }, {
        input: part.tokens,
        cached: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
      }, Math.max(1, part.events));
    }
  }
}

async function loadHermesUsage(dbPath: string): Promise<HermesUsageRow[]> {
  let DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
    close(): void;
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return [];
  }

  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(row => row.name),
    );
    if (!tables.has('sessions')) return [];

    if (tables.has('session_model_usage')) {
      const rows = db.prepare(`
        SELECT s.started_at AS started_at, u.model AS model, u.api_call_count AS events,
               u.input_tokens AS input, u.output_tokens AS output,
               u.cache_read_tokens AS cached, u.cache_write_tokens AS cache_write,
               u.reasoning_tokens AS reasoning
        FROM session_model_usage u
        JOIN sessions s ON s.id = u.session_id
        WHERE ${kiroGoSql('u')}
      `).all() as HermesSqlRow[];
      return rows.map(parseHermesSqlRow).filter((row): row is HermesUsageRow => row != null);
    }

    const rows = db.prepare(`
      SELECT started_at, model, api_call_count AS events,
             input_tokens AS input, output_tokens AS output,
             cache_read_tokens AS cached, cache_write_tokens AS cache_write,
             reasoning_tokens AS reasoning
      FROM sessions
      WHERE ${kiroGoSql()}
    `).all() as HermesSqlRow[];
    return rows.map(parseHermesSqlRow).filter((row): row is HermesUsageRow => row != null);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function kiroGoSql(alias = ''): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return `
    ${col('billing_base_url')} LIKE '%:8080/%'
    OR ${col('billing_base_url')} LIKE '%:8080'
    OR ${col('billing_base_url')} LIKE '%kiro.%'
    OR ${col('billing_provider')} LIKE '%kiro-go%'
    OR ${col('billing_provider')} LIKE '%kiro%'
  `;
}

interface HermesSqlRow {
  started_at?: number | string;
  model?: string;
  events?: number;
  input?: number;
  output?: number;
  cached?: number;
  cache_write?: number;
  reasoning?: number;
}

function parseHermesSqlRow(row: HermesSqlRow): HermesUsageRow | null {
  const started = Number(row.started_at);
  if (!Number.isFinite(started) || started <= 0) return null;
  const when = new Date(started > 1e12 ? started : started * 1000);
  if (Number.isNaN(when.getTime())) return null;
  const input = Math.max(0, Math.round(Number(row.input ?? 0)));
  const output = Math.max(0, Math.round(Number(row.output ?? 0)));
  const cached = Math.max(0, Math.round(Number(row.cached ?? 0)));
  const cacheWrite = Math.max(0, Math.round(Number(row.cache_write ?? 0)));
  const reasoning = Math.max(0, Math.round(Number(row.reasoning ?? 0)));
  const events = Math.max(1, Math.round(Number(row.events ?? 1)));
  if (input + output + cached + cacheWrite + reasoning <= 0) return null;
  return {
    when,
    model: String(row.model ?? 'auto'),
    events,
    input,
    output,
    cached,
    cacheWrite,
    reasoning,
  };
}

async function loadLifetimeSnapshot(
  extraDirs: readonly string[] = [],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<LifetimeSnapshot | null> {
  let best: LifetimeSnapshot | null = null;
  for (const file of await listLifetimeConfigFiles(extraDirs, home, env)) {
    const snapshot = await readLifetimeConfig(file);
    if (!snapshot) continue;
    if (!best || snapshot.totalTokens > best.totalTokens) best = snapshot;
  }
  return best;
}

async function listLifetimeConfigFiles(
  extraDirs: readonly string[],
  home: string,
  env: NodeJS.Dict<string>,
): Promise<string[]> {
  const files = new Set<string>();
  for (const root of resolveKiroProxyDataDirs(extraDirs, home, env)) {
    for (const candidate of [root, join(root, 'data')]) {
      try {
        const info = await stat(candidate);
        if (info.isFile() && basename(candidate) === 'config.json') files.add(candidate);
        else if (info.isDirectory()) {
          const entries = await readdir(candidate);
          if (entries.includes('config.json')) files.add(join(candidate, 'config.json'));
        }
      } catch {
        continue;
      }
    }
  }
  return [...files];
}

async function readLifetimeConfig(filePath: string): Promise<LifetimeSnapshot | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
    const totalTokens = Math.max(0, Math.round(Number(raw.totalTokens ?? raw.total_tokens ?? 0)));
    if (totalTokens <= 0) return null;
    const totalRequests = Math.max(0, Math.round(Number(raw.totalRequests ?? raw.total_requests ?? 0)));
    return { totalTokens, totalRequests };
  } catch {
    return null;
  }
}

function groupHermesByDay(rows: HermesUsageRow[]): Map<string, HermesUsageRow[]> {
  const byDay = new Map<string, HermesUsageRow[]>();
  for (const row of rows) {
    const usageDate = dateKey(row.when);
    const list = byDay.get(usageDate);
    if (list) list.push(row);
    else byDay.set(usageDate, [row]);
  }
  return byDay;
}

function splitEvenly(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function sharesFromHermes(rows: HermesUsageRow[]): ModelShare[] {
  const byModel = new Map<string, ModelShare>();
  for (const row of rows) {
    const model = normalizeProxyModel(row.model);
    const current = byModel.get(model) ?? { model, tokens: 0, events: 0 };
    current.tokens += rowTokens(row);
    current.events += row.events;
    byModel.set(model, current);
  }
  return [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
}

function splitByShare(totalTokens: number, totalEvents: number, shares: ModelShare[]): ModelShare[] {
  if (shares.length === 0) {
    return [{ model: 'auto', tokens: totalTokens, events: totalEvents }];
  }
  const tokenSum = shares.reduce((sum, share) => sum + share.tokens, 0);
  const eventSum = shares.reduce((sum, share) => sum + share.events, 0) || shares.length;
  const parts: ModelShare[] = [];
  let usedTokens = 0;
  let usedEvents = 0;
  for (const [index, share] of shares.entries()) {
    const last = index === shares.length - 1;
    const tokens = last
      ? totalTokens - usedTokens
      : Math.round(totalTokens * (share.tokens / tokenSum));
    const events = last
      ? Math.max(0, totalEvents - usedEvents)
      : Math.max(0, Math.round(totalEvents * (share.events / eventSum)));
    usedTokens += tokens;
    usedEvents += events;
    if (tokens > 0) parts.push({ model: share.model, tokens, events });
  }
  return parts.length > 0 ? parts : [{ model: shares[0].model, tokens: totalTokens, events: totalEvents }];
}

function rowTokens(row: HermesUsageRow): number {
  return row.input + row.output + row.cached + row.cacheWrite + row.reasoning;
}
