import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  accumulate,
  dateKey,
  emptyResult,
  finalize,
  initDateMap,
  resolveProjectFields,
} from './utils.js';
import { normalizeProxyModel } from './kiro-proxy.js';
import { resolveHermesDbPath } from './kiro-recovered.js';

/**
 * Hermes Agent (`~/.hermes/state.db`).
 *
 * Kiro-Go 流量仍由 kiro-recovered 记到 Kiro，避免重复。
 * 这里只收独立 Hermes 会话（OpenModel、自建网关等）。
 */

const HERMES_PRODUCT = 'hermes';

export function resolveStandaloneHermesDbPath(
  explicit?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string {
  return resolveHermesDbPath(explicit, home, env);
}

export async function discoverHermesProjects(
  hermesDbPath?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<string[]> {
  const names = new Set<string>();
  for (const row of await loadStandaloneHermesUsage(resolveHermesDbPath(hermesDbPath, home, env))) {
    const name = row.project.split(/[\\/]+/).filter(Boolean).at(-1);
    if (name && name !== 'unknown') names.add(name);
  }
  return [...names];
}

export async function discoverHermesDates(
  hermesDbPath?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<string[]> {
  const dates = new Set<string>();
  for (const row of await loadStandaloneHermesUsage(resolveHermesDbPath(hermesDbPath, home, env))) {
    dates.add(dateKey(row.when));
  }
  return [...dates];
}

export async function scanHermesDates(
  targetDates: string[],
  options: {
    hermesDbPath?: string;
    home?: string;
    env?: NodeJS.Dict<string>;
    projectAliases?: Record<string, string>;
  } = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  if (dates.size === 0) return emptyResult(dates);
  const grouped = initDateMap(dates);
  const dbPath = resolveHermesDbPath(options.hermesDbPath, options.home, options.env);

  for (const row of await loadStandaloneHermesUsage(dbPath)) {
    const usageDate = dateKey(row.when);
    if (!dates.has(usageDate)) continue;
    const day = grouped.get(usageDate);
    if (!day) continue;
    const model = normalizeProxyModel(row.model);
    const provider = HERMES_PRODUCT;
    const projectFields = resolveProjectFields(row.project, options.projectAliases);
    accumulate(day, `${model}|${projectFields.project}`, {
      provider,
      product: HERMES_PRODUCT,
      channel: 'ide',
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
    });
    const existing = day.get(`${model}|${projectFields.project}`);
    if (existing && row.events > 1) existing.eventCount += row.events - 1;
  }

  return finalize(grouped);
}

interface HermesRow {
  when: Date;
  model: string;
  project: string;
  events: number;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
}

function isKiroGoBilling(provider?: string | null, baseUrl?: string | null): boolean {
  const billing = `${provider ?? ''} ${baseUrl ?? ''}`.toLowerCase();
  return billing.includes('kiro-go') || billing.includes('kiro.') || /:8080(?:\/|$)/.test(billing);
}

async function loadStandaloneHermesUsage(dbPath: string): Promise<HermesRow[]> {
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
    db = new DatabaseSync(resolve(isAbsolute(dbPath) ? dbPath : join(homedir(), dbPath)), { readOnly: true });
  } catch {
    return [];
  }

  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(row => row.name),
    );
    if (!tables.has('sessions')) return [];

    const sql = tables.has('session_model_usage')
      ? `
        SELECT s.started_at AS started_at, u.model AS model, u.api_call_count AS events,
               u.input_tokens AS input, u.output_tokens AS output,
               u.cache_read_tokens AS cached, u.cache_write_tokens AS cache_write,
               u.reasoning_tokens AS reasoning,
               u.billing_provider AS billing_provider, u.billing_base_url AS billing_base_url,
               s.cwd AS cwd, s.git_repo_root AS git_repo_root
        FROM session_model_usage u
        JOIN sessions s ON s.id = u.session_id
      `
      : `
        SELECT started_at, model, api_call_count AS events,
               input_tokens AS input, output_tokens AS output,
               cache_read_tokens AS cached, cache_write_tokens AS cache_write,
               reasoning_tokens AS reasoning,
               billing_provider, billing_base_url, cwd, git_repo_root
        FROM sessions
      `;

    const rows = db.prepare(sql).all() as Array<{
      started_at?: number | string;
      model?: string;
      events?: number;
      input?: number;
      output?: number;
      cached?: number;
      cache_write?: number;
      reasoning?: number;
      billing_provider?: string;
      billing_base_url?: string;
      cwd?: string;
      git_repo_root?: string;
    }>;

    const out: HermesRow[] = [];
    for (const row of rows) {
      if (isKiroGoBilling(row.billing_provider, row.billing_base_url)) continue;
      const started = Number(row.started_at);
      if (!Number.isFinite(started) || started <= 0) continue;
      const when = new Date(started > 1e12 ? started : started * 1000);
      if (Number.isNaN(when.getTime())) continue;
      const input = Math.max(0, Math.round(Number(row.input ?? 0)));
      const output = Math.max(0, Math.round(Number(row.output ?? 0)));
      const cached = Math.max(0, Math.round(Number(row.cached ?? 0)));
      const cacheWrite = Math.max(0, Math.round(Number(row.cache_write ?? 0)));
      const reasoning = Math.max(0, Math.round(Number(row.reasoning ?? 0)));
      if (input + output + cached + cacheWrite + reasoning <= 0) continue;
      out.push({
        when,
        model: String(row.model ?? 'auto'),
        project: String(row.git_repo_root || row.cwd || 'hermes').trim() || 'hermes',
        events: Math.max(1, Math.round(Number(row.events ?? 1))),
        input,
        output,
        cached,
        cacheWrite,
        reasoning,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}
