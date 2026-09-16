import { readFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  dateKey,
  inferProviderFromModel,
  initDateMap,
  parseTs,
  resolveProjectFields,
  walkFiles,
  emptyResult,
  finalize,
  accumulate,
  mergeHourlyResults,
} from './utils.js';
import { scanKiroProxyDates } from './kiro-proxy.js';
import { scanKiroRecoveredDates } from './kiro-recovered.js';

/**
 * Kiro IDE / CLI / proxy scanner.
 *
 * IDE sessions: ~/.kiro/sessions/{workspace}/sess_<id>/session.json + messages.jsonl
 * Token counts are not stored. Estimates follow tokscale's MIT parser:
 *   input  = contextUsage% × 200k (fallback: prompt chars / 4)
 *   output = (assistant + tool_call args) chars / 4
 * Only character counts are used; conversation text is not kept.
 *
 * Proxy logs (Kiro-Go request_logs.json, kiro.rs usage_log.*.jsonl) are scanned
 * separately as channel=api with real token counters from the upstream stream.
 */

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MODEL = 'auto';

interface KiroSession {
  id?: string;
  modelId?: string;
  workspacePaths?: string[];
  createdAt?: string;
  lastModifiedAt?: string;
}

interface IdeTurn {
  promptChars: number;
  assistantChars: number;
  promptTs?: Date;
  endTs?: Date;
  contextUsagePercentage: number;
}

export function resolveKiroSessionsDir(home = homedir()): string {
  return process.env.KIRO_SESSIONS_DIR?.trim() || join(home, '.kiro', 'sessions');
}

export interface KiroScanOptions {
  proxyDataDirs?: readonly string[];
  hermesDbPath?: string;
  home?: string;
  env?: NodeJS.Dict<string>;
}

export async function scanKiroDates(
  targetDates: string[],
  sessionsDir?: string,
  projectAliases?: Record<string, string>,
  options: KiroScanOptions = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const [ide, proxy, recovered] = await Promise.all([
    scanKiroIdeDates(targetDates, sessionsDir, projectAliases),
    scanKiroProxyDates(targetDates, {
      extraDirs: options.proxyDataDirs,
      home: options.home,
      env: options.env,
      projectAliases,
    }),
    scanKiroRecoveredDates(targetDates, {
      extraDirs: options.proxyDataDirs,
      hermesDbPath: options.hermesDbPath,
      home: options.home,
      env: options.env,
      projectAliases,
    }),
  ]);
  return mergeBreakdownMaps(dates, ide, proxy, recovered);
}

async function scanKiroIdeDates(
  targetDates: string[],
  sessionsDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const root = sessionsDir ?? resolveKiroSessionsDir();
  const sessionFiles = (await walkFiles(root, '.json')).filter(isKiroSessionFile);
  if (sessionFiles.length === 0) return emptyResult(dates);

  const grouped = initDateMap(dates);

  for (const sessionPath of sessionFiles) {
    const session = await readSession(sessionPath);
    const turns = await parseIdeTurns(join(dirname(sessionPath), 'messages.jsonl'));
    if (turns.length === 0) continue;

    const model = normalizeKiroModel(session?.modelId);
    const projectFields = resolveProjectFields(projectPathFor(session, sessionPath), projectAliases);
    const provider = inferProviderFromModel(model, 'kiro');

    for (const turn of turns) {
      const when = turn.promptTs ?? turn.endTs;
      if (!when) continue;
      const usageDate = dateKey(when);
      if (!dates.has(usageDate)) continue;

      const input = turn.contextUsagePercentage > 0
        ? Math.round(DEFAULT_CONTEXT_WINDOW * turn.contextUsagePercentage / 100)
        : estimateTokens(turn.promptChars);
      const output = estimateTokens(turn.assistantChars);
      if (input + output <= 0) continue;

      const dayMap = grouped.get(usageDate);
      if (!dayMap) continue;
      accumulate(dayMap, `${model}|${projectFields.project}`, {
        provider,
        product: 'kiro',
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
        input,
        cached: 0,
        cacheWrite: 0,
        output,
        reasoning: 0,
      }, 1, when);
    }
  }

  return finalize(grouped);
}

function mergeBreakdownMaps(
  dates: Set<string>,
  ...maps: Array<Map<string, IngestBreakdown[]>>
): Map<string, IngestBreakdown[]> {
  const merged = emptyResult(dates);
  for (const date of dates) {
    merged.set(date, maps.flatMap(map => map.get(date) ?? []));
  }
  mergeHourlyResults(merged, maps);
  return merged;
}

export function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function normalizeKiroModel(modelId?: string): string {
  const value = modelId?.trim();
  if (!value) return DEFAULT_MODEL;
  const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  const lower = bare.toLowerCase();
  if (lower === 'agent' || lower === 'qdev' || lower === 'auto') return DEFAULT_MODEL;
  return bare.replace(/-thinking$/i, '');
}

function isKiroSessionFile(filePath: string): boolean {
  if (basename(filePath) !== 'session.json') return false;
  return !filePath.includes(`${sep}snapshots${sep}`);
}

function projectPathFor(session: KiroSession | null, sessionPath: string): string {
  const fromSession = session?.workspacePaths?.find(path => path.trim());
  if (fromSession) return fromSession;
  const workspaceDir = dirname(dirname(sessionPath));
  return basename(workspaceDir) || 'unknown';
}

async function readSession(sessionPath: string): Promise<KiroSession | null> {
  try {
    return JSON.parse(await readFile(sessionPath, 'utf-8')) as KiroSession;
  } catch {
    return null;
  }
}

async function parseIdeTurns(messagesPath: string): Promise<IdeTurn[]> {
  let content: string;
  try {
    content = await readFile(messagesPath, 'utf-8');
  } catch {
    return [];
  }

  const turns: IdeTurn[] = [];
  let current: IdeTurn | null = null;
  let structured = false;
  let flatPrompt = 0;
  let flatAssistant = 0;
  let flatTs: Date | undefined;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = asRecord(entry.payload);
    const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
    if (payload && payloadType) {
      structured = true;
      const timestamp = parseTs(typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number' ? entry.timestamp : undefined);
      switch (payloadType) {
        case 'user': {
          current ??= emptyTurn();
          current.promptChars += textChars(payload.content);
          current.promptTs ??= timestamp ?? undefined;
          break;
        }
        case 'assistant': {
          if (current) current.assistantChars += textChars(payload.content);
          break;
        }
        case 'tool_call': {
          if (current) current.assistantChars += jsonChars(payload.args);
          break;
        }
        case 'session_metadata': {
          if (payload.key === 'contextUsage' && current) {
            const usage = asRecord(payload.value);
            const pct = Number(usage?.usagePercentage);
            if (Number.isFinite(pct) && pct > 0) current.contextUsagePercentage = pct;
          }
          break;
        }
        case 'turn_end': {
          if (current) {
            current.endTs = timestamp ?? current.endTs;
            if (current.promptChars > 0 || current.assistantChars > 0) turns.push(current);
          }
          current = null;
          break;
        }
        default:
          break;
      }
      continue;
    }

    const role = typeof entry.role === 'string' ? entry.role : undefined;
    const chars = textChars(entry.content);
    flatTs ??= parseTs(typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number' ? entry.timestamp : undefined) ?? undefined;
    if (role === 'user' || role === 'human' || role === 'prompt') flatPrompt += chars;
    if (role === 'assistant' || role === 'bot') flatAssistant += chars;
  }

  if (current && (current.promptChars > 0 || current.assistantChars > 0)) turns.push(current);
  if (structured) return turns;
  if (flatPrompt + flatAssistant <= 0) return [];
  return [{ promptChars: flatPrompt, assistantChars: flatAssistant, promptTs: flatTs, contextUsagePercentage: 0 }];
}

function emptyTurn(): IdeTurn {
  return { promptChars: 0, assistantChars: 0, contextUsagePercentage: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textChars(value: unknown): number {
  return typeof value === 'string' ? [...value].length : 0;
}

function jsonChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return [...value].length;
  try {
    return [...JSON.stringify(value)].length;
  } catch {
    return 0;
  }
}
