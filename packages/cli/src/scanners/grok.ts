import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  accumulate,
  dateKey,
  emptyResult,
  finalize,
  inferProviderFromModel,
  initDateMap,
  parseTs,
  resolveProjectFields,
} from './utils.js';

/**
 * xAI Grok Build CLI scanner.
 *
 * Sessions live under $GROK_HOME/sessions/{url-encoded-cwd}/{session-id}/
 * Token splits come from updates.jsonl `params.update.usage` (one completed turn
 * per usage snapshot). Cost is left to the shared xAI list-price catalog.
 */

const DEFAULT_MODEL = 'grok-4.6';
const PRODUCT = 'grok';

export interface GrokScanOptions {
  sessionsDir?: string;
  home?: string;
  env?: NodeJS.Dict<string>;
  projectAliases?: Record<string, string>;
}

interface GrokUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  modelUsage?: Record<string, GrokUsage>;
}

interface GrokSummary {
  current_model_id?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  info?: { cwd?: string; id?: string };
}

export function resolveGrokHome(
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string {
  const raw = env.GROK_HOME?.trim() || env.TOKENTRACKER_GROK_HOME?.trim() || join(home, '.grok');
  return resolve(isAbsolute(raw) ? raw : join(home, raw));
}

export function resolveGrokSessionsDir(
  explicit?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string {
  if (explicit?.trim()) {
    const raw = explicit.trim();
    return resolve(isAbsolute(raw) ? raw : join(home, raw));
  }
  return join(resolveGrokHome(home, env), 'sessions');
}

export async function discoverGrokDates(
  sessionsDir?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<Set<string>> {
  const dates = new Set<string>();
  for (const session of await listGrokSessions(resolveGrokSessionsDir(sessionsDir, home, env))) {
    for (const row of await readSessionUsage(session)) {
      dates.add(dateKey(row.when));
    }
  }
  return dates;
}

export async function discoverGrokProjects(
  sessionsDir?: string,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<string[]> {
  const names = new Set<string>();
  for (const session of await listGrokSessions(resolveGrokSessionsDir(sessionsDir, home, env))) {
    const cwd = session.cwd || decodeGrokCwd(basename(session.groupDir));
    const name = basename(cwd.trim());
    if (name && name !== 'unknown') names.add(name);
  }
  return [...names];
}

export async function scanGrokDates(
  targetDates: string[],
  sessionsDir?: string,
  projectAliases?: Record<string, string>,
  options: Omit<GrokScanOptions, 'sessionsDir' | 'projectAliases'> = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  if (dates.size === 0) return new Map();

  const grouped = initDateMap(dates);
  const sessions = await listGrokSessions(
    resolveGrokSessionsDir(sessionsDir, options.home, options.env),
  );
  if (sessions.length === 0) return emptyResult(dates);

  for (const session of sessions) {
    const projectFields = resolveProjectFields(
      session.cwd || decodeGrokCwd(basename(session.groupDir)),
      projectAliases,
    );
    const fallbackModel = session.model || DEFAULT_MODEL;
    const seen = new Set<string>();

    for (const row of await readSessionUsage(session)) {
      const usageDate = dateKey(row.when);
      const day = grouped.get(usageDate);
      if (!day) continue;

      const dedupeKey = `${session.id}:${row.turnId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      for (const part of row.parts) {
        const model = normalizeGrokModel(part.model || fallbackModel);
        const provider = inferProviderFromModel(model, 'xai');
        if (part.input + part.cached + part.cacheWrite + part.output + part.reasoning <= 0) continue;
        accumulate(day, `${model}|${projectFields.project}`, {
          provider,
          product: PRODUCT,
          channel: 'cli',
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
          input: part.input,
          cached: part.cached,
          cacheWrite: part.cacheWrite,
          output: part.output,
          reasoning: part.reasoning,
        }, part.events);
      }
    }
  }

  return finalize(grouped);
}

export function normalizeGrokModel(modelId?: string): string {
  const value = modelId?.trim();
  if (!value) return DEFAULT_MODEL;
  const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return bare.replace(/-thinking$/i, '') || DEFAULT_MODEL;
}

export function decodeGrokCwd(encoded: string): string {
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.trim() || encoded;
  } catch {
    return encoded;
  }
}

interface GrokSession {
  id: string;
  dir: string;
  groupDir: string;
  cwd?: string;
  model?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface GrokUsagePart {
  model: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  events: number;
}

interface GrokUsageRow {
  when: Date;
  turnId: string;
  parts: GrokUsagePart[];
}

async function listGrokSessions(sessionsDir: string): Promise<GrokSession[]> {
  const sessions: GrokSession[] = [];
  let groups: string[];
  try {
    groups = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(sessionsDir, entry.name));
  } catch {
    return [];
  }

  for (const groupDir of groups) {
    let children: string[];
    try {
      children = (await readdir(groupDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => join(groupDir, entry.name));
    } catch {
      continue;
    }
    for (const dir of children) {
      const summary = await readSummary(join(dir, 'summary.json'));
      sessions.push({
        id: summary?.info?.id || basename(dir),
        dir,
        groupDir,
        cwd: summary?.info?.cwd?.trim() || undefined,
        model: summary?.current_model_id?.trim() || undefined,
        createdAt: parseTs(summary?.created_at) ?? undefined,
        updatedAt: parseTs(summary?.last_active_at) ?? parseTs(summary?.updated_at) ?? undefined,
      });
    }
  }
  return sessions;
}

async function readSessionUsage(session: GrokSession): Promise<GrokUsageRow[]> {
  const rows = await readUpdatesUsage(join(session.dir, 'updates.jsonl'), session);
  if (rows.length > 0) return rows;
  return readSignalsFallback(session);
}

async function readUpdatesUsage(filePath: string, session: GrokSession): Promise<GrokUsageRow[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const rows: GrokUsageRow[] = [];
  let index = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const params = asRecord(record.params) ?? record;
    const update = asRecord(params.update);
    const usage = asRecord(update?.usage);
    if (!usage) continue;

    const meta = asRecord(params._meta);
    const turnId = stringValue(update?.prompt_id)
      || stringValue(meta?.promptId)
      || stringValue(meta?.eventId)
      || `${session.id}:${index}`;
    index += 1;
    const when = parseTs(record.timestamp)
      ?? parseTs(meta?.agentTimestampMs)
      ?? parseTs(meta?.turnStartMs)
      ?? session.updatedAt
      ?? session.createdAt;
    if (!when) continue;

    const parts = partsFromUsage(usage, session.model || DEFAULT_MODEL);
    if (parts.length === 0) continue;
    rows.push({ when, turnId, parts });
  }
  return rows;
}

async function readSignalsFallback(session: GrokSession): Promise<GrokUsageRow[]> {
  let signals: Record<string, unknown>;
  try {
    signals = JSON.parse(await readFile(join(session.dir, 'signals.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tokens = Math.max(0, Math.round(Number(signals.contextTokensUsed ?? 0)));
  if (tokens <= 0) return [];
  const when = session.updatedAt ?? session.createdAt;
  if (!when) return [];
  const model = stringValue(signals.primaryModelId) || session.model || DEFAULT_MODEL;
  const events = Math.max(1, Math.round(Number(signals.turnCount ?? 1)));
  return [{
    when,
    turnId: `${session.id}:signals`,
    parts: [{
      model,
      input: tokens,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      events,
    }],
  }];
}

function partsFromUsage(usage: Record<string, unknown>, fallbackModel: string): GrokUsagePart[] {
  const modelUsage = asRecord(usage.modelUsage);
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    const parts: GrokUsagePart[] = [];
    for (const [model, raw] of Object.entries(modelUsage)) {
      const part = usagePart(asRecord(raw) ?? {}, model || fallbackModel);
      if (part) parts.push(part);
    }
    return parts;
  }
  const part = usagePart(usage, fallbackModel);
  return part ? [part] : [];
}

function usagePart(usage: Record<string, unknown>, model: string): GrokUsagePart | null {
  const input = readToken(usage.inputTokens);
  const output = readToken(usage.outputTokens);
  const cached = readToken(usage.cachedReadTokens);
  const cacheWrite = readToken(usage.cacheCreationTokens);
  const reasoning = readToken(usage.reasoningTokens);
  if (input + output + cached + cacheWrite + reasoning <= 0) return null;
  return {
    model,
    input,
    cached,
    cacheWrite,
    output,
    reasoning,
    events: Math.max(1, Math.round(Number(usage.modelCalls ?? 1))),
  };
}

async function readSummary(filePath: string): Promise<GrokSummary | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as GrokSummary;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readToken(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
