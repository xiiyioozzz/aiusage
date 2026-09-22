import { describe, expect, it } from 'vitest';
import { calculateCost, getPricingCatalog, resetModelsDevCache, resolveLiveCatalog } from '../pricing/index.js';
import { parseXaiPricingPage, supplementCatalogFromXaiPricing } from '../pricing/xai-live.js';

const page = `
| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-4.9 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |
| grok-4.9 (≥ 200k prompt tokens) | 500k | $4.00 | $1.00 | $12.00 |
| grok-4.7 (< 200k prompt tokens) | 500k | $99.00 | $99.00 | $99.00 |
| grok-4.7 (≥ 200k prompt tokens) | 500k | $99.00 | $99.00 | $99.00 |

## Grok 4.9 Fast pricing (Cursor and Grok Build only)

Grok 4.9 Fast is the same model at a higher rate.

| Prompt tokens | Input | Cached input | Output |
| --- | --- | --- | --- |
| Below 200k | $4.00 / 1M | $1.00 / 1M | $12.00 / 1M |
| Above 200k | $6.00 / 1M | $1.50 / 1M | $18.00 / 1M |

## Grok 4.7 Fast pricing

| Prompt tokens | Input | Cached input | Output |
| --- | --- | --- | --- |
| Below 200k | $99.00 / 1M | $99.00 / 1M | $99.00 / 1M |
| Above 200k | $99.00 / 1M | $99.00 / 1M | $99.00 / 1M |
`;

const tokens = {
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1_000_000,
};

describe('xAI 价目页', () => {
  it('解析标准档和 Fast 档', () => {
    const models = parseXaiPricingPage(page);
    expect(models['grok-4.9']?.tiers?.[0]?.input_per_million).toBe(2);
    expect(models['grok-4.9']?.tiers?.[1]?.output_per_million).toBe(12);
    expect(models['grok-4.9-fast']?.tiers?.[1]?.cached_input_per_million).toBe(1.5);
  });

  it('不覆盖目录里已有的 grok-4.7 Fast', () => {
    const models = parseXaiPricingPage(page);
    const catalog = supplementCatalogFromXaiPricing(getPricingCatalog(), models, [
      { provider: 'cursor', product: 'cursor', model: 'cursor-grok-4.7-xhigh-fast' },
    ]);
    const priced = calculateCost('cursor', 'cursor', 'cursor-grok-4.7-xhigh-fast', tokens, { catalog });
    expect(priced.resolvedModel).toBe('grok-4.7-fast');
    expect(priced.estimatedCostUsd).toBeCloseTo(24, 4);
    expect(catalog.version).not.toContain('+xai-docs');
  });

  it('目录没有的 Fast 型号先补标准档，再用价目页的 Fast 阶梯', async () => {
    resetModelsDevCache();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return new Response(JSON.stringify({
          xai: {
            models: {
              'grok-4.9': {
                id: 'grok-4.9',
                cost: {
                  input: 2,
                  output: 6,
                  cache_read: 0.5,
                  tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: 'context', size: 200_000 } }],
                },
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(page, { status: 200 });
    }) as typeof fetch;

    const catalog = await resolveLiveCatalog(getPricingCatalog(), [
      { provider: 'xai', product: 'grok', model: 'grok-4.9-fast' },
    ], fetchImpl);
    const priced = calculateCost('xai', 'grok', 'grok-4.9-fast', tokens, { catalog });
    expect(priced.resolvedModel).toBe('grok-4.9-fast');
    expect(priced.costStatus).toBe('exact');
    expect(priced.estimatedCostUsd).toBeCloseTo(24, 4);
    resetModelsDevCache();
  });
});
