import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { type IngestBreakdown } from '@aiusage/shared';
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
  takeHourly,
} from './utils.js';
import { scanKiroProxyDates } from './kiro-proxy.js';
import { scanKiroRecoveredDates } from './kiro-recovered.js';

/**
 * Kiro IDE / CLI / proxy scanner.
 *
 * IDE sessions: ~/.kiro/sessions/{workspace}/sess_<id>/session.json + messages.jsonl
 * Official usage_summary lines store credits only — no model, no API tokens.
 * Tokens come from the session model + server-reported contextUsage%:
 *   input  = contextUsage% × that model's official window (1M / 256k / 200k / 128k)
 *   output = (assistant + tool_call args) chars / 4
 * Cost is the same model's public API list price (not Kiro's $0.04 overage credit).
 *
 * globalStorage execution files (kiro.kiroagent) fill days that have no
 * messages.jsonl turns, using the same context% × model-window estimate.
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
  credits: number;
}

interface SessionMeta {
  model: string;
  project: string;
}

interface ExecutionEvent {
  when: Date;
  sessionId?: string;
  credits: number;
  contextUsagePercentage: number;
}

interface TokenDelta {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export function resolveKiroSessionsDir(home = homedir()): string {
  return process.env.KIRO_SESSIONS_DIR?.trim() || join(home, '.kiro', 'sessions');
}

export function resolveKiroAgentStorageDir(
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string {
  const fromEnv = env.KIRO_AGENT_STORAGE?.trim() || env.KIRO_GLOBAL_STORAGE?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  }
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
}

export interface KiroScanOptions {
  proxyDataDirs?: readonly string[];
  hermesDbPath?: string;
  home?: string;
  env?: NodeJS.Dict<string>;
  agentStorageDir?: string;
}

export async function scanKiroDates(
  targetDates: string[],
  sessionsDir?: string,
  projectAliases?: Record<string, string>,
  options: KiroScanOptions = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const [ide, proxy, recovered] = await Promise.all([
    scanKiroIdeDates(targetDates, sessionsDir, projectAliases, options),
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

export async function discoverKiroIdeDates(
  sessionsDir?: string,
  options: KiroScanOptions = {},
): Promise<Set<string>> {
  const dates = new Set<string>();
  const home = options.home ?? homedir();
  const root = sessionsDir ?? resolveKiroSessionsDir(home);
  for (const sessionPath of (await walkFiles(root, '.json')).filter(isKiroSessionFile)) {
    const session = await readSession(sessionPath);
    const created = parseTs(session?.createdAt ?? session?.lastModifiedAt);
    if (created) dates.add(dateKey(created));
    for (const turn of await parseIdeTurns(join(dirname(sessionPath), 'messages.jsonl'))) {
      const when = turn.promptTs ?? turn.endTs;
      if (when) dates.add(dateKey(when));
    }
  }
  for (const event of await loadExecutionEvents(options.agentStorageDir ?? resolveKiroAgentStorageDir(home, options.env))) {
    dates.add(dateKey(event.when));
  }
  return dates;
}

async function scanKiroIdeDates(
  targetDates: string[],
  sessionsDir?: string,
  projectAliases?: Record<string, string>,
  options: KiroScanOptions = {},
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const home = options.home ?? homedir();
  const root = sessionsDir ?? resolveKiroSessionsDir(home);
  const sessionIndex = new Map<string, SessionMeta>();
  const turnsByDate = new Map<string, Array<IdeTurn & SessionMeta>>();

  const sessionFiles = (await walkFiles(root, '.json')).filter(isKiroSessionFile);
  for (const sessionPath of sessionFiles) {
    const session = await readSession(sessionPath);
    const model = normalizeKiroModel(session?.modelId);
    const project = projectPathFor(session, sessionPath);
    rememberSession(sessionIndex, session?.id, dirname(sessionPath), { model, project });
    const turns = await parseIdeTurns(join(dirname(sessionPath), 'messages.jsonl'));
    for (const turn of turns) {
      const when = turn.promptTs ?? turn.endTs;
      if (!when) continue;
      const usageDate = dateKey(when);
      if (!dates.has(usageDate)) continue;
      const list = turnsByDate.get(usageDate) ?? [];
      list.push({ ...turn, model, project });
      turnsByDate.set(usageDate, list);
    }
  }

  await hydrateWorkspaceSessions(
    sessionIndex,
    options.agentStorageDir ?? resolveKiroAgentStorageDir(home, options.env),
  );
  const executions = (await loadExecutionEvents(
    options.agentStorageDir ?? resolveKiroAgentStorageDir(home, options.env),
  )).filter(event => dates.has(dateKey(event.when)));

  const execByDate = new Map<string, ExecutionEvent[]>();
  for (const event of executions) {
    const usageDate = dateKey(event.when);
    const list = execByDate.get(usageDate) ?? [];
    list.push(event);
    execByDate.set(usageDate, list);
  }

  if (sessionFiles.length === 0 && executions.length === 0) return emptyResult(dates);

  const grouped = initDateMap(dates);
  for (const usageDate of dates) {
    const dayMap = grouped.get(usageDate);
    if (!dayMap) continue;
    const turns = turnsByDate.get(usageDate) ?? [];
    const dayExecs = execByDate.get(usageDate) ?? [];

    if (turns.length > 0) {
      for (const turn of turns) {
        emitIdeEvent(dayMap, projectAliases, {
          when: turn.promptTs ?? turn.endTs as Date,
          model: turn.model,
          project: turn.project,
          tokens: estimateTurnTokens(turn, turn.model),
        });
      }
      continue;
    }

    for (const event of dayExecs) {
      const meta = lookupSession(sessionIndex, event.sessionId);
      const model = meta?.model ?? DEFAULT_MODEL;
      emitIdeEvent(dayMap, projectAliases, {
        when: event.when,
        model,
        project: meta?.project ?? event.sessionId ?? 'unknown',
        tokens: tokensFromContext(event.contextUsagePercentage, model),
      });
    }
  }

  return finalize(grouped);
}

function emitIdeEvent(
  dayMap: Map<string, IngestBreakdown>,
  projectAliases: Record<string, string> | undefined,
  event: { when: Date; model: string; project: string; tokens: TokenDelta },
): void {
  const tokens = event.tokens;
  if (tokens.input + tokens.output + tokens.cached + tokens.cacheWrite + tokens.reasoning <= 0) {
    return;
  }
  const projectFields = resolveProjectFields(event.project, projectAliases);
  const provider = inferProviderFromModel(event.model, 'kiro');
  accumulate(dayMap, `${event.model}|${projectFields.project}`, {
    tokenQuality: 'estimated',
    provider,
    product: 'kiro',
    channel: 'ide',
    model: event.model,
    project: projectFields.project,
    projectDisplay: projectFields.projectDisplay,
    projectAlias: projectFields.projectAlias,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }, tokens, 1, event.when);
}

function estimateTurnTokens(turn: IdeTurn, model: string): TokenDelta {
  const input = turn.contextUsagePercentage > 0
    ? Math.round(contextWindowForModel(model) * turn.contextUsagePercentage / 100)
    : estimateTokens(turn.promptChars);
  return {
    input,
    cached: 0,
    cacheWrite: 0,
    output: estimateTokens(turn.assistantChars),
    reasoning: 0,
  };
}

function tokensFromContext(contextUsagePercentage: number, model: string): TokenDelta {
  if (!(contextUsagePercentage > 0)) return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  return {
    input: Math.round(contextWindowForModel(model) * contextUsagePercentage / 100),
    cached: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  };
}

function mergeBreakdownMaps(
  dates: Set<string>,
  ...maps: Array<Map<string, IngestBreakdown[]>>
): Map<string, IngestBreakdown[]> {
  const merged = emptyResult(dates);
  const hourly = takeHourly(merged)!;
  for (const date of dates) {
    // Request logs take precedence over Hermes session aggregates for the same
    // day/model/project. They have no shared request ID, so adding both invents
    // usage; Hermes only fills scopes without request-level observations.
    const selected = new Map<string, { source: number; row: IngestBreakdown }>();
    for (const [source, map] of maps.entries()) {
      for (const row of map.get(date) ?? []) {
        const key = breakdownKey(row);
        if (!selected.has(key)) selected.set(key, { source, row });
      }
    }
    merged.set(date, [...selected.values()].map(({ row }) => ({ ...row })));
    const hours = new Map<number, Map<string, IngestBreakdown>>();
    for (const [source, map] of maps.entries()) {
      for (const [hour, rows] of takeHourly(map)?.get(date) ?? []) {
        for (const row of rows.values()) {
          const key = breakdownKey(row);
          if (selected.get(key)?.source !== source) continue;
          let bucket = hours.get(hour);
          if (!bucket) {
            bucket = new Map();
            hours.set(hour, bucket);
          }
          bucket.set(key, { ...row });
        }
      }
    }
    if (hours.size) hourly.set(date, hours);
  }
  return merged;
}

function breakdownKey(row: IngestBreakdown): string {
  return JSON.stringify([row.provider, row.product, row.channel, row.model, row.project]);
}

export function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Official Kiro context windows: https://kiro.dev/docs/models/ */
export function contextWindowForModel(model: string): number {
  const key = normalizeKiroModel(model).toLowerCase().replace(/\./g, '-');
  if (key.includes('qwen3-coder-next') || key.includes('qwen-3-coder-next')) return 256_000;
  if (key.includes('deepseek-3-2')) return 128_000;
  if (
    /opus-4-5/.test(key)
    || /sonnet-4-5/.test(key)
    || /sonnet-4-0/.test(key)
    || /haiku/.test(key)
    || /glm-5/.test(key)
    || /minimax/.test(key)
  ) {
    return 200_000;
  }
  if (
    /opus-5/.test(key)
    || /opus-4-[678]/.test(key)
    || /sonnet-5/.test(key)
    || /sonnet-4-6/.test(key)
    || /fable-5/.test(key)
    || /gpt-5-6/.test(key)
  ) {
    return 1_000_000;
  }
  return DEFAULT_CONTEXT_WINDOW;
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

function rememberSession(
  index: Map<string, SessionMeta>,
  sessionId: string | undefined,
  sessionDir: string,
  meta: SessionMeta,
): void {
  for (const key of sessionKeys(sessionId, basename(sessionDir))) {
    if (!index.has(key)) index.set(key, meta);
  }
}

function lookupSession(index: Map<string, SessionMeta>, sessionId?: string): SessionMeta | undefined {
  if (!sessionId) return undefined;
  return index.get(sessionId) ?? index.get(sessionId.replace(/^sess_/, ''));
}

function sessionKeys(...values: Array<string | undefined>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    keys.add(trimmed);
    keys.add(trimmed.replace(/^sess_/, ''));
  }
  return [...keys];
}

async function readSession(sessionPath: string): Promise<KiroSession | null> {
  try {
    return JSON.parse(await readFile(sessionPath, 'utf-8')) as KiroSession;
  } catch {
    return null;
  }
}

export async function parseIdeTurns(messagesPath: string): Promise<IdeTurn[]> {
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
  let flatCredits = 0;

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
            if (Number.isFinite(pct) && pct > current.contextUsagePercentage) {
              current.contextUsagePercentage = pct;
            }
          }
          break;
        }
        case 'usage_summary': {
          const credits = creditsFromUsageSummary(payload);
          if (current) current.credits += credits;
          else if (turns.length) turns[turns.length - 1]!.credits += credits;
          else flatCredits += credits;
          break;
        }
        case 'turn_end': {
          if (current) {
            current.endTs = timestamp ?? current.endTs;
            if (current.promptChars > 0 || current.assistantChars > 0 || current.credits > 0) {
              turns.push(current);
            }
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

  if (current && (current.promptChars > 0 || current.assistantChars > 0 || current.credits > 0)) {
    turns.push(current);
  }
  if (structured) return turns;
  if (flatPrompt + flatAssistant + flatCredits <= 0) return [];
  return [{
    promptChars: flatPrompt,
    assistantChars: flatAssistant,
    promptTs: flatTs,
    contextUsagePercentage: 0,
    credits: flatCredits,
  }];
}

function creditsFromUsageSummary(payload: Record<string, unknown>): number {
  const items = payload.promptTurnSummaries;
  if (!Array.isArray(items)) return readCreditValue(payload);
  return items.reduce((sum, item) => sum + (asRecord(item) ? readCreditValue(item as Record<string, unknown>) : 0), 0);
}

function readCreditValue(value: Record<string, unknown>): number {
  const usage = Number(value.usage);
  if (!Number.isFinite(usage) || usage <= 0) return 0;
  const unit = String(value.unit ?? value.unitPlural ?? 'credit').toLowerCase();
  if (unit.includes('credit') || unit === '') return usage;
  return 0;
}

function emptyTurn(): IdeTurn {
  return { promptChars: 0, assistantChars: 0, contextUsagePercentage: 0, credits: 0 };
}

async function hydrateWorkspaceSessions(
  index: Map<string, SessionMeta>,
  storageDir: string,
): Promise<void> {
  const root = join(storageDir, 'workspace-sessions');
  for (const filePath of await walkFiles(root, '.json')) {
    if (basename(filePath).startsWith('._') || basename(filePath) === 'sessions.json') continue;
    const data = asRecord(await readJson(filePath));
    if (!data) continue;
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
    const model = normalizeKiroModel(
      typeof data.selectedModel === 'string' ? data.selectedModel : undefined,
    );
    const project = typeof data.workspaceDirectory === 'string' && data.workspaceDirectory.trim()
      ? data.workspaceDirectory
      : typeof data.workspacePath === 'string' ? data.workspacePath : 'unknown';
    rememberSession(index, sessionId, dirname(filePath), { model, project });
  }
}

async function loadExecutionEvents(storageDir: string): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for (const filePath of await listCandidateFiles(storageDir)) {
    const data = asRecord(await readJson(filePath));
    if (!data || !isExecutionRecord(data)) continue;
    const when = parseTs(typeof data.startTime === 'number' || typeof data.startTime === 'string'
      ? data.startTime
      : data.endTime as string | number | undefined);
    if (!when) continue;
    const credits = creditsFromExecution(data);
    const pct = Number(data.contextUsagePercentage);
    events.push({
      when,
      sessionId: typeof data.chatSessionId === 'string' ? data.chatSessionId : undefined,
      credits,
      contextUsagePercentage: Number.isFinite(pct) && pct > 0 ? pct : 0,
    });
  }
  return events;
}

function creditsFromExecution(data: Record<string, unknown>): number {
  const summary = data.usageSummary;
  if (Array.isArray(summary)) {
    return summary.reduce((sum, item) => sum + (asRecord(item) ? readCreditValue(item as Record<string, unknown>) : 0), 0);
  }
  return asRecord(summary) ? readCreditValue(summary as Record<string, unknown>) : 0;
}

function isExecutionRecord(data: Record<string, unknown>): boolean {
  if (data.usageSummary != null) return true;
  return typeof data.executionId === 'string' && Array.isArray(data.actions);
}

async function listCandidateFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkCandidates(root, 0, out);
  return out;
}

async function walkCandidates(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'workspace-sessions' || entry.name === 'dev_data' || entry.name === 'snapshots') continue;
      await walkCandidates(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.jsonl') || entry.name.startsWith('._')) continue;
    try {
      const info = await stat(full);
      if (info.size < 40 || info.size > 15_000_000) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    if (!raw.trimStart().startsWith('{') && !raw.trimStart().startsWith('[')) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
