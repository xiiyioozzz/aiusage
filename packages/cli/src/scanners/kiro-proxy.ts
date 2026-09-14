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
  parseTs,
  resolveProjectFields,
} from './utils.js';

/**
 * Kiro-Go / kiro.rs proxy usage.
 *
 * Kiro-Go writes a 500-entry ring buffer at data/request_logs.json:
 *   { time, model, status, tokens, credits }
 * tokens is usually input+output combined; split fields are used when present.
 *
 * kiro.rs writes usage_log.YYYY-MM-DD.jsonl next to credentials.json:
 *   { ts, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, credits, status }
 *
 * Cost is left to the shared catalog (Kiro → official Anthropic/OpenAI list prices).
 */

const REQUEST_LOG = 'request_logs.json';
const USAGE_LOG_RE = /^usage_log\.(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface KiroProxyScanOptions {
  extraDirs?: readonly string[];
  home?: string;
  env?: NodeJS.Dict<string>;
  projectAliases?: Record<string, string>;
}

interface ProxyEvent {
  when: Date;
  model: string;
  project: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  dedupKey: string;
}

export function resolveKiroProxyDataDirs(
  extraDirs: readonly string[] = [],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string[] {
  const fromEnv = [
    ...splitPathList(env.KIRO_GO_DATA_DIR),
    ...splitPathList(env.KIRO_RS_DATA_DIR),
    ...splitPathList(env.KIRO_PROXY_DATA_DIR),
  ];
  const defaults = [
    join(home, '.kiro-go', 'data'),
    join(home, '.kiro-go'),
    join(home, 'kiro-go', 'data'),
    join(home, 'Kiro-Go', 'data'),
    join(home, '.kiro.rs'),
    join(home, '.kiro-rs'),
    join(home, '.config', 'kiro-rs'),
    join(home, '.local', 'share', 'kiro-rs'),
    join(home, 'kiro-rs'),
  ];
  return uniqueResolved([...fromEnv, ...extraDirs, ...defaults], home);
}

export async function listKiroProxyLogFiles(
  extraDirs: readonly string[] = [],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<string[]> {
  const files: string[] = [];
  for (const root of resolveKiroProxyDataDirs(extraDirs, home, env)) {
    for (const file of await collectLogFiles(root)) files.push(file.path);
  }
  return [...new Set(files)].sort();
}

export async function discoverKiroProxyDates(
  extraDirs: readonly string[] = [],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<Set<string>> {
  const dates = new Set<string>();
  for (const event of await loadProxyEvents(extraDirs, home, env)) {
    dates.add(dateKey(event.when));
  }
  return dates;
}

export async function scanKiroProxyDates(
  targetDates: string[],
  options: KiroProxyScanOptions = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  if (dates.size === 0) return new Map();

  const events = await loadProxyEvents(
    options.extraDirs,
    options.home,
    options.env,
  );
  if (events.length === 0) return emptyResult(dates);

  const grouped = initDateMap(dates);
  for (const event of events) {
    const usageDate = dateKey(event.when);
    if (!dates.has(usageDate)) continue;
    const day = grouped.get(usageDate);
    if (!day) continue;

    const model = normalizeProxyModel(event.model);
    const projectFields = resolveProjectFields(event.project, options.projectAliases);
    const provider = inferProviderFromModel(model, 'kiro');
    accumulate(day, `api|${model}|${projectFields.project}`, {
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
      input: event.input,
      cached: event.cached,
      cacheWrite: event.cacheWrite,
      output: event.output,
      reasoning: 0,
    });
  }

  return finalize(grouped);
}

async function loadProxyEvents(
  extraDirs: readonly string[] = [],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): Promise<ProxyEvent[]> {
  const selected = new Map<string, ProxyEvent>();
  for (const root of resolveKiroProxyDataDirs(extraDirs, home, env)) {
    for (const file of await collectLogFiles(root)) {
      const parsed = file.kind === 'go'
        ? await parseGoRequestLogs(file.path)
        : await parseRsUsageLog(file.path);
      for (const event of parsed) {
        if (!selected.has(event.dedupKey)) selected.set(event.dedupKey, event);
      }
    }
  }
  return [...selected.values()];
}

async function collectLogFiles(root: string): Promise<Array<{ kind: 'go' | 'rs'; path: string }>> {
  const out: Array<{ kind: 'go' | 'rs'; path: string }> = [];
  try {
    const info = await stat(root);
    if (info.isFile()) {
      const name = basename(root);
      if (name === REQUEST_LOG) out.push({ kind: 'go', path: root });
      else if (USAGE_LOG_RE.test(name)) out.push({ kind: 'rs', path: root });
      return out;
    }
  } catch {
    return out;
  }

  for (const dir of uniqueResolved([root, join(root, 'data')])) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      if (entry.name === REQUEST_LOG) out.push({ kind: 'go', path });
      else if (USAGE_LOG_RE.test(entry.name)) out.push({ kind: 'rs', path });
    }
  }
  return out;
}

async function parseGoRequestLogs(filePath: string): Promise<ProxyEvent[]> {
  const raw = await readJson(filePath);
  const rows = Array.isArray(raw) ? raw : [];
  const events: ProxyEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row) || isEmptyFailure(row.status, row)) continue;
    const when = parseTs(row.time ?? row.timestamp);
    if (!when) continue;
    const tokens = readTokens(row);
    if (tokens.input + tokens.cached + tokens.cacheWrite + tokens.output <= 0) continue;
    const model = readString(row.model) || 'auto';
    events.push({
      when,
      model,
      project: 'kiro-go',
      ...tokens,
      dedupKey: `go|${when.getTime()}|${model}|${tokens.input}|${tokens.output}|${tokens.cached}|${readNumber(row.credits)}`,
    });
  }
  return events;
}

async function parseRsUsageLog(filePath: string): Promise<ProxyEvent[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const events: ProxyEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (isEmptyFailure(row.status, row)) continue;
    const when = parseTs(row.ts ?? row.timestamp ?? row.time);
    if (!when) continue;
    const tokens = readTokens(row);
    if (tokens.input + tokens.cached + tokens.cacheWrite + tokens.output <= 0) continue;
    const model = readString(row.model) || 'auto';
    events.push({
      when,
      model,
      project: 'kiro-rs',
      ...tokens,
      dedupKey: `rs|${when.toISOString()}|${model}|${tokens.input}|${tokens.output}|${tokens.cached}|${tokens.cacheWrite}|${readNumber(row.credits)}`,
    });
  }
  return events;
}

function readTokens(row: Record<string, unknown>): {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
} {
  const cached = Math.max(0, Math.round(
    readNumber(row.cacheReadTokens ?? row.cache_read_tokens ?? row.cachedInputTokens),
  ));
  const cacheWrite = Math.max(0, Math.round(
    readNumber(row.cacheCreationTokens ?? row.cache_creation_tokens ?? row.cacheWriteTokens),
  ));
  const splitInput = readOptionalNumber(
    row.inputTokens ?? row.input_tokens ?? row.promptTokens ?? row.prompt_tokens,
  );
  const splitOutput = readOptionalNumber(
    row.outputTokens ?? row.output_tokens ?? row.completionTokens ?? row.completion_tokens,
  );
  if (splitInput != null || splitOutput != null) {
    return {
      input: Math.max(0, Math.round(splitInput ?? 0)),
      cached,
      cacheWrite,
      output: Math.max(0, Math.round(splitOutput ?? 0)),
    };
  }

  // Kiro-Go request_logs.json only persists the combined token count.
  const combined = Math.max(0, Math.round(readNumber(row.tokens ?? row.totalTokens ?? row.total_tokens)));
  return { input: combined, cached, cacheWrite, output: 0 };
}

export function normalizeProxyModel(modelId?: string): string {
  const value = modelId?.trim();
  if (!value) return 'auto';
  const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  const lower = bare.toLowerCase();
  if (lower === 'agent' || lower === 'qdev' || lower === 'auto') return 'auto';
  return bare.replace(/-thinking$/i, '');
}

function isEmptyFailure(status: unknown, row: Record<string, unknown>): boolean {
  if (status == null || status === '') return false;
  if (String(status).toLowerCase() === 'success') return false;
  const tokens = readTokens(row);
  return tokens.input + tokens.cached + tokens.cacheWrite + tokens.output <= 0;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function splitPathList(value?: string): string[] {
  if (!value?.trim()) return [];
  return value.split(/[,;\n]/).map(part => part.trim()).filter(Boolean);
}

function uniqueResolved(paths: string[], home = homedir()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = resolve(isAbsolute(trimmed) ? trimmed : join(home, trimmed));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}
