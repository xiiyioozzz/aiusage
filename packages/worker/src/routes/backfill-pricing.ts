import type { Channel, PricingCatalog, PricingUsage } from '@aiusage/shared';
import { getPricingCatalog, hasListPrice, resolveLiveCatalog } from '@aiusage/shared';
import type { Env } from '../types.js';
import { calculateIngestBreakdownCost } from '../utils/pricing.js';
import { parseExtraMetrics, refreshDailyUsageCost } from './ingest.js';

interface StoredRow {
  device_id: string;
  usage_date: string;
  usage_hour?: number;
  provider: string;
  product: string;
  channel: string;
  model: string;
  project: string;
  event_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  extra_metrics_json: string | null;
}

let inflight: Promise<number> | null = null;

/** Reprice stored rows whose model was missing from the catalog. */
export function backfillUnpricedModels(env: Env, fetchImpl?: typeof fetch): Promise<number> {
  if (inflight && !fetchImpl) return inflight;
  const run = runBackfill(env, fetchImpl).finally(() => {
    if (inflight === run) inflight = null;
  });
  if (!fetchImpl) inflight = run;
  return run;
}

async function runBackfill(env: Env, fetchImpl?: typeof fetch): Promise<number> {
  const listed = await env.DB.prepare(`
    SELECT provider, product, model FROM daily_usage_breakdown WHERE cost_status = 'unavailable'
    UNION
    SELECT provider, product, model FROM hourly_usage_breakdown WHERE cost_status = 'unavailable'
  `).all<PricingUsage>();
  const usages = listed.results ?? [];
  if (usages.length === 0) return 0;

  const catalog = await resolveLiveCatalog(getPricingCatalog(), usages, fetchImpl);
  const priceable = usages.filter((usage) => hasListPrice(usage.provider, usage.product, usage.model, catalog));
  if (priceable.length === 0) return 0;

  const now = new Date().toISOString();
  const touched = new Set<string>();
  const updated = await repriceTable(env, 'daily_usage_breakdown', priceable, catalog, now, touched)
    + await repriceTable(env, 'hourly_usage_breakdown', priceable, catalog, now, touched);
  for (const key of touched) {
    const splitAt = key.indexOf('\u0000');
    await refreshDailyUsageCost(env, key.slice(0, splitAt), key.slice(splitAt + 1), now);
  }
  return updated;
}

async function repriceTable(
  env: Env,
  table: 'daily_usage_breakdown' | 'hourly_usage_breakdown',
  priceable: PricingUsage[],
  catalog: PricingCatalog,
  now: string,
  touched: Set<string>,
): Promise<number> {
  const isHourly = table === 'hourly_usage_breakdown';
  let updated = 0;
  for (const usage of priceable) {
    const page = await env.DB.prepare(`
      SELECT device_id, usage_date, ${isHourly ? 'usage_hour,' : ''} provider, product, channel, model, project,
             event_count, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
             reasoning_output_tokens, extra_metrics_json
      FROM ${table}
      WHERE cost_status = 'unavailable' AND provider = ? AND product = ? AND model = ?
    `).bind(usage.provider, usage.product, usage.model).all<StoredRow>();

    for (const row of page.results ?? []) {
      const extra = parseExtraMetrics(row.extra_metrics_json);
      const cost = calculateIngestBreakdownCost({
        provider: row.provider,
        product: row.product,
        channel: row.channel as Channel,
        model: row.model,
        project: row.project,
        eventCount: Number(row.event_count ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        cachedInputTokens: Number(row.cached_input_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        cacheWrite5mTokens: extra.cacheWrite5mTokens ?? Number(row.cache_write_tokens ?? 0),
        cacheWrite1hTokens: extra.cacheWrite1hTokens ?? 0,
        outputTokens: Number(row.output_tokens ?? 0),
        reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
        tokenQuality: extra.tokenQuality,
      }, catalog);
      if (cost.estimatedCostUsd <= 0) continue;
      await env.DB.prepare(`
        UPDATE ${table}
        SET estimated_cost_usd = ?, cost_status = ?, pricing_version = ?, updated_at = ?
        WHERE device_id = ? AND usage_date = ? AND provider = ? AND product = ?
          AND channel = ? AND model = ? AND project = ?
          ${isHourly ? 'AND usage_hour = ?' : ''}
      `).bind(
        cost.estimatedCostUsd,
        cost.costStatus,
        cost.pricingVersion,
        now,
        row.device_id,
        row.usage_date,
        row.provider,
        row.product,
        row.channel,
        row.model,
        row.project,
        ...(isHourly ? [row.usage_hour!] : []),
      ).run();
      touched.add(`${row.device_id}\u0000${row.usage_date}`);
      updated += 1;
    }
  }
  return updated;
}
