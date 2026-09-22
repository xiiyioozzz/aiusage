import type { ModelPricing, PricingCatalog, PricingTier } from './types.js';
import { canonicalListModel, hasListPrice } from './calculate.js';
import type { PricingUsage } from './models-dev.js';

export const XAI_PRICING_URL = 'https://docs.x.ai/developers/pricing';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

interface Rate {
  input: number;
  output: number;
  cached?: number;
  threshold?: number;
}

let cachedPage: { at: number; models: Record<string, ModelPricing> } | null = null;
let failedAt = 0;

export function resetXaiPricingCache(): void {
  cachedPage = null;
  failedAt = 0;
}

export function usagesNeedXaiLive(catalog: PricingCatalog, usages: PricingUsage[]): boolean {
  return usages.some((usage) => {
    const listed = canonicalListModel(usage.model);
    if (listed.provider !== 'xai') return false;
    if (!hasListPrice(usage.provider, usage.product, usage.model, catalog)) return true;
    return listed.fast && !catalog.providers.xai?.grok?.models?.[`${listed.id}-fast`];
  });
}

export async function loadXaiPricingModels(fetchImpl?: typeof fetch): Promise<Record<string, ModelPricing> | null> {
  const now = Date.now();
  if (cachedPage && now - cachedPage.at < CACHE_TTL_MS) return cachedPage.models;
  if (!fetchImpl && process.env.VITEST === 'true') return null;
  if (!fetchImpl && failedAt && now - failedAt < FAILURE_TTL_MS) return cachedPage?.models ?? null;

  try {
    const response = await (fetchImpl ?? fetch)(XAI_PRICING_URL, {
      headers: { Accept: 'text/markdown, text/plain;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`xAI pricing ${response.status}`);
    const models = parseXaiPricingPage(await response.text());
    if (Object.keys(models).length === 0) throw new Error('xAI pricing page');
    cachedPage = { at: now, models };
    failedAt = 0;
    return models;
  } catch {
    failedAt = now;
    return cachedPage?.models ?? null;
  }
}

/** 解析 docs.x.ai 价目页。已有目录条目不会在 supplement 时被覆盖。 */
export function parseXaiPricingPage(source: string): Record<string, ModelPricing> {
  const text = source.includes('<html') ? htmlTableText(source) : source;
  const models: Record<string, ModelPricing> = {};
  for (const table of markdownTables(text)) {
    const header = table[0]?.map((cell) => cell.toLowerCase()) ?? [];
    if (header.some((cell) => cell.includes('model')) && header.some((cell) => cell.includes('input'))) {
      parseStandardTable(table, models);
    }
  }
  parseFastSections(text, models);
  return models;
}

export function supplementCatalogFromXaiPricing(
  catalog: PricingCatalog,
  models: Record<string, ModelPricing>,
  usages: PricingUsage[],
): PricingCatalog {
  let draft: PricingCatalog | null = null;
  const ensure = (): PricingCatalog => {
    if (!draft) draft = structuredClone(catalog);
    return draft;
  };

  let added = false;
  for (const usage of usages) {
    const listed = canonicalListModel(usage.model);
    if (listed.provider !== 'xai') continue;
    const current = draft ?? catalog;
    const bucket = current.providers.xai?.grok?.models ?? {};
    const baseId = resolveParsedId(models, listed.id);
    const fastId = baseId ? `${baseId}-fast` : `${listed.id}-fast`;
    const missingBase = !hasListPrice(usage.provider, usage.product, usage.model, current);
    const missingFast = listed.fast && !bucket[fastId];
    if ((!missingBase || !baseId) && (!missingFast || !models[fastId])) continue;

    const next = ensure();
    const product = next.providers.xai ?? (next.providers.xai = {});
    const grok = product.grok ?? (product.grok = { models: {} });
    if (missingBase && baseId && models[baseId] && !grok.models[baseId]) {
      grok.models[baseId] = models[baseId];
      if (listed.id !== baseId && !next.aliases[listed.id]) next.aliases[listed.id] = baseId;
      added = true;
    }
    if (missingFast && models[fastId] && !grok.models[fastId]) {
      grok.models[fastId] = models[fastId];
      added = true;
    }
  }

  if (!draft || !added) return catalog;
  draft.version = catalog.version.includes('+xai-docs') ? catalog.version : `${catalog.version}+xai-docs`;
  return draft;
}

function resolveParsedId(models: Record<string, ModelPricing>, id: string): string | null {
  if (models[id]) return id;
  const keys = Object.keys(models).filter((key) => !key.endsWith('-fast')).sort((a, b) => b.length - a.length);
  for (const known of keys) {
    if (!id.startsWith(`${known}-`)) continue;
    const suffix = id.slice(known.length + 1);
    if (/^\d+(?:[-.]\d+)*(?:-\d{6,8})?$/.test(suffix)) continue;
    return known;
  }
  return null;
}

function parseStandardTable(table: string[][], models: Record<string, ModelPricing>): void {
  const grouped = new Map<string, { low?: Rate; high?: Rate }>();
  for (const row of table.slice(1)) {
    const parsed = parseModelCell(row[0] ?? '');
    const input = money(row[2] ?? '');
    const cached = money(row[3] ?? '');
    const output = money(row[4] ?? '');
    if (!parsed || input == null || output == null) continue;
    const rate: Rate = { input, output, ...(cached != null ? { cached } : {}), ...(parsed.threshold ? { threshold: parsed.threshold } : {}) };
    const entry = grouped.get(parsed.id) ?? {};
    if (parsed.above) entry.high = rate;
    else entry.low = rate;
    grouped.set(parsed.id, entry);
  }
  for (const [id, rates] of grouped) {
    const pricing = ratesToPricing(rates.low, rates.high, 'xAI pricing page');
    if (pricing) models[id] = pricing;
  }
}

function parseFastSections(text: string, models: Record<string, ModelPricing>): void {
  const pattern = /Grok\s+(\d+(?:\.\d+)*)\s+Fast\b([\s\S]*?)(?=\n#{1,3}\s|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const id = `grok-${match[1]}-fast`;
    const tables = markdownTables(match[2] ?? '');
    const table = tables.find((rows) => rows[0]?.some((cell) => /input/i.test(cell)));
    if (!table) continue;
    let low: Rate | undefined;
    let high: Rate | undefined;
    for (const row of table.slice(1)) {
      const label = row[0] ?? '';
      const input = money(row[1] ?? '');
      const cached = money(row[2] ?? '');
      const output = money(row[3] ?? '');
      if (input == null || output == null) continue;
      const threshold = parseTokenSize(label);
      const rate: Rate = { input, output, ...(cached != null ? { cached } : {}), ...(threshold ? { threshold } : {}) };
      if (/above|≥|>=|>/i.test(label)) high = rate;
      else low = rate;
    }
    const pricing = ratesToPricing(low, high, 'xAI pricing page, fast');
    if (pricing) models[id] = pricing;
  }
}

function ratesToPricing(low: Rate | undefined, high: Rate | undefined, notes: string): ModelPricing | null {
  if (!low && !high) return null;
  if (low && high) {
    const tiers: PricingTier[] = [
      {
        ...(low.threshold ? { threshold: low.threshold } : {}),
        input_per_million: low.input,
        output_per_million: low.output,
        ...(low.cached != null ? { cached_input_per_million: low.cached } : {}),
      },
      {
        input_per_million: high.input,
        output_per_million: high.output,
        ...(high.cached != null ? { cached_input_per_million: high.cached } : {}),
      },
    ];
    return { currency: 'USD', notes, tiers };
  }
  const only = low ?? high;
  if (!only) return null;
  return {
    currency: 'USD',
    notes,
    input_per_million: only.input,
    output_per_million: only.output,
    ...(only.cached != null ? { cached_input_per_million: only.cached } : {}),
  };
}

function parseModelCell(cell: string): { id: string; threshold?: number; above: boolean } | null {
  const match = cell.trim().match(/^([a-z0-9][a-z0-9._-]*)\s*(?:\(([^)]*)\))?/i);
  if (!match) return null;
  const id = match[1].toLowerCase();
  if (!id.startsWith('grok-') || id.includes('imagine')) return null;
  const condition = match[2] ?? '';
  return {
    id,
    threshold: parseTokenSize(condition),
    above: /≥|>=|(?<!<)>/.test(condition),
  };
}

function parseTokenSize(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*([kKmM])\b/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return match[2].toLowerCase() === 'm' ? value * 1_000_000 : value * 1_000;
}

function money(cell: string): number | undefined {
  const match = cell.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function markdownTables(text: string): string[][][] {
  const tables: string[][][] = [];
  let rows: string[][] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (rows.length > 0) tables.push(rows);
      rows = [];
      continue;
    }
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 0 || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(cells);
  }
  if (rows.length > 0) tables.push(rows);
  return tables;
}

function htmlTableText(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
}
