import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
import { normalizeProxyModel } from './kiro-proxy.js';

/**
 * Recover Kiro-Go usage from Hermes session/model aggregates. Their only time
 * anchor is the session start, so this is an estimate of daily attribution.
 * Lifetime counters have no date/model split and must never be distributed
 * across historical dates. Request logs take precedence in scanKiroDates.
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
      tokenQuality: 'estimated',
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
    }, row.events, row.when);
  }
}

async function loadHermesUsage(dbPath: string): Promise<HermesUsageRow[]> {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
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
               u.reasoning_tokens AS reasoning,
               u.billing_provider, u.billing_base_url
        FROM session_model_usage u
        JOIN sessions s ON s.id = u.session_id
      `).all() as HermesSqlRow[];
      return rows.filter(row => isKiroGoBilling(row.billing_provider, row.billing_base_url))
        .map(parseHermesSqlRow).filter((row): row is HermesUsageRow => row != null);
    }

    const rows = db.prepare(`
      SELECT started_at, model, api_call_count AS events,
             input_tokens AS input, output_tokens AS output,
             cache_read_tokens AS cached, cache_write_tokens AS cache_write,
             reasoning_tokens AS reasoning, billing_provider, billing_base_url
      FROM sessions
    `).all() as HermesSqlRow[];
    return rows.filter(row => isKiroGoBilling(row.billing_provider, row.billing_base_url))
      .map(parseHermesSqlRow).filter((row): row is HermesUsageRow => row != null);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Shared by both scanners so every Hermes row belongs to exactly one source. */
export function isKiroGoBilling(provider?: string | null, baseUrl?: string | null): boolean {
  const billing = `${provider ?? ''} ${baseUrl ?? ''}`.toLowerCase();
  return (provider ?? '').toLowerCase().includes('kiro')
    || billing.includes('kiro.') || /:8080(?:\/|$)/.test(billing);
}

interface HermesSqlRow {
  billing_provider?: string;
  billing_base_url?: string;
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

