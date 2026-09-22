/**
 * Worker 侧定价入口 —— 转发到 @aiusage/shared 的统一定价目录。
 * 历史 ModelPricing / PricingCatalog 类型保留 re-export 以兼容现有调用。
 */
import { calculateCost as calculateSharedCost } from '@aiusage/shared';
import type { CostCalcResult, IngestBreakdown, PricingCatalog } from '@aiusage/shared';

export function calculateIngestBreakdownCost(
  breakdown: IngestBreakdown,
  catalog?: PricingCatalog,
): CostCalcResult {
  const calculated = calculateSharedCost(
    breakdown.provider,
    breakdown.product,
    breakdown.model,
    {
      inputTokens: breakdown.inputTokens,
      cachedInputTokens: breakdown.cachedInputTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      cacheWrite5mTokens: breakdown.cacheWrite5mTokens ?? breakdown.cacheWriteTokens,
      cacheWrite1hTokens: breakdown.cacheWrite1hTokens ?? 0,
      // Ingest stores visible output and reasoning separately; both are billed.
      outputTokens: breakdown.outputTokens + (breakdown.reasoningOutputTokens ?? 0),
    },
    {
      requestCount: breakdown.eventCount,
      ...(catalog ? { catalog } : {}),
    },
  );

  const hasVendorReportedCost = breakdown.product === 'trae-intl'
    || breakdown.product === 'opencode';
  if (
    breakdown.costUSD == null ||
    !Number.isFinite(breakdown.costUSD) ||
    breakdown.costUSD <= 0 ||
    (!hasVendorReportedCost && breakdown.pricingVersion !== calculated.pricingVersion)
  ) {
    return breakdown.tokenQuality === 'estimated' && calculated.costStatus !== 'unavailable'
      ? { ...calculated, costStatus: 'estimated' }
      : calculated;
  }

  return {
    ...calculated,
    estimatedCostUsd: breakdown.costUSD,
    costStatus: breakdown.tokenQuality === 'estimated' ? 'estimated' : 'exact',
  };
}

export {
  calculateCost,
  getWorstCostStatus,
  getPricingCatalog,
  catalog,
  PRICING_VERSION,
} from '@aiusage/shared';

export type {
  ModelPricing,
  PricingCatalog,
  ProductPricing,
  Currency,
  PricingTier,
  CostCalcInput,
  CostCalcResult,
} from '@aiusage/shared';
