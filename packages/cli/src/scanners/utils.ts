import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';

/** 早于此刻视为脏数据下界（2015-01-01），用于过滤被误判单位的时间戳 */
const MIN_VALID_MS = Date.UTC(2015, 0, 1);

export function parseTs(value?: string | number): Date | null {
  if (value == null || value === '') return null;
  // 数值时间戳：区分秒级（10 位）与毫秒级（13 位）。
  // 形如 1775196391.26 的秒级值若按毫秒解析会落到 1970，需先 ×1000。
  let input: string | number = value;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(value)) {
    const num = typeof value === 'number' ? value : Number(value);
    input = num < 1e12 ? num * 1000 : num;
  }
  const d = new Date(input);
  const t = d.getTime();
  if (isNaN(t) || t < MIN_VALID_MS) return null;
  return d;
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 文件内没有可靠时间戳时，以 mtime 兜底，避免有真实 token 的记录被静默丢弃。 */
export async function fileModifiedTs(filePath: string): Promise<Date | null> {
  try {
    return parseTs((await stat(filePath)).mtimeMs);
  } catch {
    return null;
  }
}

/** 根据模型名推断底层供应商；无法识别时保留调用方指定的产品供应商。 */
export function inferProviderFromModel(model: string, fallback: string): string {
  const value = model.trim().toLowerCase();
  if (/^(claude|opus|sonnet|haiku|fable|mythos)(?:[-.]|$)/.test(value)) return 'anthropic';
  if (/^(gpt|chatgpt|codex|o[134])(?:[-.]|$)/.test(value)) return 'openai';
  if (/^gemini(?:[-.]|$)/.test(value)) return 'google';
  if (/^qwen(?:[-.]|$)/.test(value)) return 'alibaba';
  if (/^deepseek(?:[-.]|$)/.test(value)) return 'deepseek';
  if (/^(glm|codegeex)(?:[-.]|$)/.test(value)) return 'zhipu';
  if (/^(kimi|moonshot)(?:[-/.]|$)/.test(value)) return 'moonshot';
  if (/^grok(?:[-.]|$)/.test(value)) return 'xai';
  return fallback;
}

export function projectFromPath(raw: string, aliases?: Record<string, string>): string {
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || 'unknown';
  return aliases?.[raw] ?? aliases?.[name] ?? name;
}

export interface ProjectFields {
  project: string;
  projectDisplay: string;
  projectAlias?: string;
}

export function resolveProjectFields(
  rawPath: string,
  aliases?: Record<string, string>,
): ProjectFields {
  const parts = rawPath.split(/[\\/]+/).filter(Boolean);
  const display = parts[parts.length - 1] || 'unknown';
  const alias = aliases?.[rawPath] ?? aliases?.[display];
  return {
    project: rawPath || 'unknown',
    projectDisplay: display,
    projectAlias: alias,
  };
}

export async function walkFiles(dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  await walk(dir, ext, result);
  return result;
}

async function walk(dir: string, ext: string, out: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
}

export type DateGrouped = Map<string, Map<string, IngestBreakdown>>;
export type HourGrouped = Map<string, Map<number, Map<string, IngestBreakdown>>>;

const hourlyByGroup = new WeakMap<Map<string, IngestBreakdown>, HourGrouped>();
const hourlyByDateMap = new WeakMap<DateGrouped, HourGrouped>();
const hourlyByResult = new WeakMap<Map<string, IngestBreakdown[]>, HourGrouped>();

export function hourOf(date: Date): number {
  return date.getHours();
}

export function initDateMap(dates: Set<string>): DateGrouped {
  const hourly: HourGrouped = new Map();
  const m: DateGrouped = new Map();
  for (const d of dates) {
    const inner = new Map<string, IngestBreakdown>();
    hourlyByGroup.set(inner, hourly);
    m.set(d, inner);
  }
  hourlyByDateMap.set(m, hourly);
  return m;
}

type TokenDelta = { input: number; cached: number; cacheWrite: number; output: number; reasoning: number };

function applyAccumulate(
  grouped: Map<string, IngestBreakdown>,
  key: string,
  base: Omit<IngestBreakdown, 'eventCount'>,
  tokens: TokenDelta,
  events: number,
): void {
  const eventCount = Math.max(1, Math.round(events));
  const existing = grouped.get(key);
  if (existing) {
    if (base.tokenQuality === 'estimated') existing.tokenQuality = 'estimated';
    else existing.tokenQuality ??= base.tokenQuality;
    existing.eventCount += eventCount;
    existing.inputTokens += tokens.input;
    existing.cachedInputTokens += tokens.cached;
    existing.cacheWriteTokens += tokens.cacheWrite;
    existing.outputTokens += tokens.output;
    existing.reasoningOutputTokens += tokens.reasoning;
    if (base.costUSD) existing.costUSD = (existing.costUSD ?? 0) + base.costUSD;
    if (base.pricingVersion) existing.pricingVersion = base.pricingVersion;
    return;
  }
  grouped.set(key, {
    ...base,
    eventCount,
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cached,
    cacheWriteTokens: tokens.cacheWrite,
    outputTokens: tokens.output,
    reasoningOutputTokens: tokens.reasoning,
  });
}

function ensureHourBucket(hourly: HourGrouped, date: string, hour: number): Map<string, IngestBreakdown> {
  let byHour = hourly.get(date);
  if (!byHour) {
    byHour = new Map();
    hourly.set(date, byHour);
  }
  let byKey = byHour.get(hour);
  if (!byKey) {
    byKey = new Map();
    byHour.set(hour, byKey);
  }
  return byKey;
}

function writeHourly(
  hourly: HourGrouped | undefined,
  when: Date,
  key: string,
  base: Omit<IngestBreakdown, 'eventCount'>,
  tokens: TokenDelta,
  events: number,
): void {
  if (!hourly) return;
  const hour = hourOf(when);
  if (hour < 0 || hour > 23) return;
  applyAccumulate(ensureHourBucket(hourly, dateKey(when), hour), key, base, tokens, events);
}

export function accumulate(
  grouped: Map<string, IngestBreakdown>,
  key: string,
  base: Omit<IngestBreakdown, 'eventCount'>,
  tokens: TokenDelta,
  events = 1,
  when?: Date,
): void {
  applyAccumulate(grouped, key, base, tokens, events);
  if (when) writeHourly(hourlyByGroup.get(grouped), when, key, base, tokens, events);
}

/** Hourly write for scanners that keep a custom daily merge (Claude / Codex). */
export function addHourly(
  dateGrouped: DateGrouped,
  when: Date,
  key: string,
  base: Omit<IngestBreakdown, 'eventCount'>,
  tokens: TokenDelta,
  events = 1,
): void {
  writeHourly(hourlyByDateMap.get(dateGrouped), when, key, base, tokens, events);
}

export function patchHourly(
  dateGrouped: DateGrouped,
  when: Date,
  key: string,
  patch: { cacheWrite5mTokens?: number; cacheWrite1hTokens?: number; costUSD?: number },
): void {
  const row = hourlyByDateMap.get(dateGrouped)?.get(dateKey(when))?.get(hourOf(when))?.get(key);
  if (!row) return;
  if (patch.cacheWrite5mTokens) {
    row.cacheWrite5mTokens = (row.cacheWrite5mTokens ?? 0) + patch.cacheWrite5mTokens;
  }
  if (patch.cacheWrite1hTokens) {
    row.cacheWrite1hTokens = (row.cacheWrite1hTokens ?? 0) + patch.cacheWrite1hTokens;
  }
  if (patch.costUSD) row.costUSD = (row.costUSD ?? 0) + patch.costUSD;
}

export function addHourlyCost(
  grouped: Map<string, IngestBreakdown>,
  when: Date,
  key: string,
  costUSD: number,
): void {
  if (!(costUSD > 0)) return;
  const hourly = hourlyByGroup.get(grouped);
  const row = hourly?.get(dateKey(when))?.get(hourOf(when))?.get(key);
  if (row) row.costUSD = (row.costUSD ?? 0) + costUSD;
}

export function finalize(groupedByDate: DateGrouped): Map<string, IngestBreakdown[]> {
  const result = new Map(
    [...groupedByDate.entries()].map(([d, m]) => [d, [...m.values()]]),
  );
  const hourly = hourlyByDateMap.get(groupedByDate);
  if (hourly) hourlyByResult.set(result, hourly);
  return result;
}

export function emptyResult(dates: Set<string>): Map<string, IngestBreakdown[]> {
  const result = new Map([...dates].map(d => [d, []]));
  hourlyByResult.set(result, new Map());
  return result;
}

export function takeHourly(result: Map<string, IngestBreakdown[]>): HourGrouped | undefined {
  return hourlyByResult.get(result);
}

function mergeBreakdown(target: IngestBreakdown, incoming: IngestBreakdown): void {
  if (incoming.tokenQuality === 'estimated') target.tokenQuality = 'estimated';
  else target.tokenQuality ??= incoming.tokenQuality;
  target.eventCount += incoming.eventCount;
  target.inputTokens += incoming.inputTokens;
  target.cachedInputTokens += incoming.cachedInputTokens;
  target.cacheWriteTokens += incoming.cacheWriteTokens;
  target.outputTokens += incoming.outputTokens;
  target.reasoningOutputTokens += incoming.reasoningOutputTokens;
  if (incoming.cacheWrite5mTokens) {
    target.cacheWrite5mTokens = (target.cacheWrite5mTokens ?? 0) + incoming.cacheWrite5mTokens;
  }
  if (incoming.cacheWrite1hTokens) {
    target.cacheWrite1hTokens = (target.cacheWrite1hTokens ?? 0) + incoming.cacheWrite1hTokens;
  }
  if (incoming.costUSD) target.costUSD = (target.costUSD ?? 0) + incoming.costUSD;
  if (incoming.sessionCount) target.sessionCount = (target.sessionCount ?? 0) + incoming.sessionCount;
}

export function mergeHourlyResults(
  target: Map<string, IngestBreakdown[]>,
  sources: Array<Map<string, IngestBreakdown[]>>,
): void {
  const dest: HourGrouped = hourlyByResult.get(target) ?? new Map();
  for (const source of sources) {
    const hourly = hourlyByResult.get(source);
    if (!hourly) continue;
    for (const [date, hours] of hourly) {
      let destHours = dest.get(date);
      if (!destHours) {
        destHours = new Map();
        dest.set(date, destHours);
      }
      for (const [hour, breakdowns] of hours) {
        let destKeys = destHours.get(hour);
        if (!destKeys) {
          destKeys = new Map();
          destHours.set(hour, destKeys);
        }
        for (const [key, incoming] of breakdowns) {
          const existing = destKeys.get(key);
          if (existing) mergeBreakdown(existing, incoming);
          else destKeys.set(key, { ...incoming });
        }
      }
    }
  }
  hourlyByResult.set(target, dest);
}

// 归一化模型名，去掉日期后缀（如 claude-3-5-sonnet-20241022 → claude-3-5-sonnet）
export function normalizeModelName(name: string): string {
  return name.replace(/-\d{8}$/, '');
}

// Pool-based 并发控制，避免同时打开过多文件句柄
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const i = nextIndex++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}
