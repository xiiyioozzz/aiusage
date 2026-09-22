import type { ProductPricing } from '../types.js';

/**
 * xAI Grok API list prices.
 * 来源：https://docs.x.ai/developers/pricing
 * 最近核对：2026-09-22
 *
 * grok-4.7 / 4.6 / 4.5 按 prompt 是否达到 200K 分档，高档价适用于整次请求。
 * grok-4.7-fast 只在 Cursor 与 Grok Build 提供，长上下文不是标准档的简单 2 倍。
 */
export const xai: Record<string, ProductPricing> = {
  grok: {
    models: {
      'grok-4.7': {
        currency: 'USD',
        effective_from: '2026-09-21',
        notes: 'tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 2, cached_input_per_million: 0.5, output_per_million: 6 },
          { input_per_million: 4, cached_input_per_million: 1, output_per_million: 12 },
        ],
      },
      'grok-4.7-fast': {
        currency: 'USD',
        effective_from: '2026-09-21',
        notes: 'Cursor and Grok Build only; tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 4, cached_input_per_million: 1, output_per_million: 12 },
          { input_per_million: 6, cached_input_per_million: 1.5, output_per_million: 18 },
        ],
      },
      'grok-4.6': {
        currency: 'USD',
        effective_from: '2026-08-12',
        notes: 'tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 2, cached_input_per_million: 0.5, output_per_million: 6 },
          { input_per_million: 4, cached_input_per_million: 1, output_per_million: 12 },
        ],
      },
      'grok-4.5': {
        currency: 'USD',
        notes: 'tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 2, cached_input_per_million: 0.3, output_per_million: 6 },
          { input_per_million: 4, cached_input_per_million: 0.6, output_per_million: 12 },
        ],
      },
    },
  },
};
