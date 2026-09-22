import type { ModelPricing, PricingCatalog, PricingTier } from './types.js';
import { canonicalListModel, hasListPrice, officialListProduct } from './calculate.js';
import { loadXaiPricingModels, resetXaiPricingCache, supplementCatalogFromXaiPricing, usagesNeedXaiLive } from './xai-live.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

export interface PricingUsage {
  provider: string;
  product: string;
  model: string;
}

interface ModelsDevCostStep {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type?: string; size?: number };
}

interface ModelsDevModel {
  id?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: ModelsDevCostStep[];
  };
}

export interface ModelsDevIndex {
  [provider: string]: {
    models?: Record<string, ModelsDevModel>;
  };
}

interface Rates {
  input?: number;
  output?: number;
  cache?: number;
  cacheWrite?: number;
}

let cachedIndex: { at: number; index: ModelsDevIndex } | null = null;
let failedAt = 0;

export function resetModelsDevCache(): void {
  cachedIndex = null;
  failedAt = 0;
  resetXaiPricingCache();
}

export function catalogNeedsLivePrices(catalog: PricingCatalog, usages: PricingUsage[]): boolean {
  return usages.some((usage) => usage.model.trim() !== ''
    && !hasListPrice(usage.provider, usage.product, usage.model, catalog));
}

export async function loadModelsDevIndex(fetchImpl?: typeof fetch): Promise<ModelsDevIndex | null> {
  const now = Date.now();
  if (cachedIndex && now - cachedIndex.at < CACHE_TTL_MS) return cachedIndex.index;
  if (!fetchImpl && process.env.VITEST === 'true') return null;
  if (!fetchImpl && failedAt && now - failedAt < FAILURE_TTL_MS) return cachedIndex?.index ?? null;

  try {
    const response = await (fetchImpl ?? fetch)(MODELS_DEV_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`models.dev ${response.status}`);
    const data: unknown = await response.json();
    if (!isModelsDevIndex(data)) throw new Error('models.dev payload');
    cachedIndex = { at: now, index: data };
    failedAt = 0;
    return data;
  } catch {
    failedAt = now;
    return cachedIndex?.index ?? null;
  }
}

export async function resolveLiveCatalog(
  catalog: PricingCatalog,
  usages: PricingUsage[],
  fetchImpl?: typeof fetch,
): Promise<PricingCatalog> {
  let next = catalog;
  if (catalogNeedsLivePrices(next, usages)) {
    const index = await loadModelsDevIndex(fetchImpl);
    if (index) next = supplementCatalogFromModelsDev(next, index, usages);
  }
  if (usagesNeedXaiLive(next, usages)) {
    const models = await loadXaiPricingModels(fetchImpl);
    if (models) next = supplementCatalogFromXaiPricing(next, models, usages);
  }
  return next;
}

/**
 * 只补目录里还算不出价的模型，不覆盖已经核对过的条目。
 * 只用 models.dev 里同名厂商的牌价，不用转售商报价。
 */
export function supplementCatalogFromModelsDev(
  catalog: PricingCatalog,
  index: ModelsDevIndex,
  usages: PricingUsage[],
): PricingCatalog {
  let draft: PricingCatalog | null = null;
  const ensure = (): PricingCatalog => {
    if (!draft) draft = structuredClone(catalog);
    return draft;
  };

  for (const usage of usages) {
    const current = draft ?? catalog;
    if (!usage.model.trim() || hasListPrice(usage.provider, usage.product, usage.model, current)) continue;
    const listed = canonicalListModel(usage.model);
    const provider = listed.provider ?? (officialListProduct(usage.provider) ? usage.provider : undefined);
    const product = provider ? officialListProduct(provider) : undefined;
    if (!provider || !product) continue;

    const models = index[provider]?.models;
    if (!models) continue;
    const base = exactOrPrefix(models, listed.id);
    if (!base) continue;
    const pricing = toModelPricing(base.model);
    if (!pricing) continue;

    const next = ensure();
    const bucket = next.providers[provider] ?? (next.providers[provider] = {});
    const productPricing = bucket[product] ?? (bucket[product] = { models: {} });
    if (!productPricing.models[base.id]) productPricing.models[base.id] = pricing;
    if (listed.id !== base.id && !next.aliases[listed.id]) next.aliases[listed.id] = base.id;

    if (!listed.fast) continue;
    const fastId = `${base.id}-fast`;
    const fastModel = models[fastId];
    const fastPricing = fastModel ? toModelPricing(fastModel) : null;
    if (fastPricing && !productPricing.models[fastId]) productPricing.models[fastId] = fastPricing;
  }

  if (!draft) return catalog;
  draft.version = catalog.version.includes('+models.dev') ? catalog.version : `${catalog.version}+models.dev`;
  return draft;
}

function toModelPricing(model: ModelsDevModel): ModelPricing | null {
  const cost = model.cost;
  if (!cost) return null;
  let current: Rates = {
    input: finite(cost.input),
    output: finite(cost.output),
    cache: finite(cost.cache_read),
    cacheWrite: finite(cost.cache_write),
  };
  if (current.input == null && current.output == null) return null;

  const steps = (cost.tiers ?? [])
    .filter((step) => step.tier?.type === 'context' && typeof step.tier.size === 'number' && step.tier.size > 0)
    .sort((a, b) => a.tier!.size! - b.tier!.size!);

  if (steps.length === 0) {
    return {
      currency: 'USD',
      notes: 'models.dev',
      input_per_million: current.input ?? 0,
      output_per_million: current.output ?? 0,
      ...(current.cache != null ? { cached_input_per_million: current.cache } : {}),
      ...(current.cacheWrite != null ? { cache_write_per_million: current.cacheWrite } : {}),
    };
  }

  const tiers: PricingTier[] = [];
  for (const step of steps) {
    tiers.push(toTier(current, step.tier!.size));
    current = {
      input: finite(step.input) ?? current.input,
      output: finite(step.output) ?? current.output,
      cache: finite(step.cache_read) ?? current.cache,
      cacheWrite: finite(step.cache_write) ?? current.cacheWrite,
    };
  }
  tiers.push(toTier(current));
  return { currency: 'USD', notes: 'models.dev', tiers };
}

function toTier(rates: Rates, threshold?: number): PricingTier {
  return {
    ...(threshold != null ? { threshold } : {}),
    input_per_million: rates.input ?? 0,
    output_per_million: rates.output ?? 0,
    ...(rates.cache != null ? { cached_input_per_million: rates.cache } : {}),
    ...(rates.cacheWrite != null ? { cache_write_per_million: rates.cacheWrite } : {}),
  };
}

function exactOrPrefix(
  models: Record<string, ModelsDevModel>,
  id: string,
): { id: string; model: ModelsDevModel } | null {
  for (const variant of idVariants(id)) {
    const direct = models[variant];
    if (direct?.cost) return { id: variant, model: direct };
  }

  const keys = Object.keys(models).sort((a, b) => b.length - a.length);
  for (const variant of idVariants(id)) {
    for (const known of keys) {
      if (!variant.startsWith(`${known}-`)) continue;
      const suffix = variant.slice(known.length + 1);
      if (/^\d+(?:[-.]\d+)*(?:-\d{6,8})?$/.test(suffix)) continue;
      const model = models[known];
      if (!model?.cost) continue;
      return { id: known, model };
    }
  }
  return null;
}

function idVariants(id: string): string[] {
  return [...new Set([
    id,
    id.replace(/(\d)\.(\d)/g, '$1-$2'),
    id.replace(/(\d)-(\d)/g, '$1.$2'),
  ])];
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isModelsDevIndex(value: unknown): value is ModelsDevIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const models = (entry as { models?: unknown }).models;
    return !!models && typeof models === 'object' && !Array.isArray(models);
  });
}
