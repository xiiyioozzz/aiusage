import { describe, expect, it } from 'vitest';
import { calculateCost, getPricingCatalog } from '../pricing/index.js';
import { supplementCatalogFromModelsDev, type ModelsDevIndex } from '../pricing/models-dev.js';

const grok48 = {
  id: 'grok-4.8',
  cost: {
    input: 2,
    output: 6,
    cache_read: 0.5,
    tiers: [
      {
        input: 4,
        output: 12,
        cache_read: 1,
        tier: { type: 'context', size: 200_000 },
      },
    ],
  },
};

const index: ModelsDevIndex = {
  xai: {
    models: {
      'grok-4.6': {
        id: 'grok-4.6',
        cost: { input: 999, output: 999, cache_read: 999 },
      },
      'grok-4.8': grok48,
      'grok-4.8-fast': {
        id: 'grok-4.8-fast',
        cost: {
          input: 4,
          output: 12,
          cache_read: 1,
          tiers: [
            { input: 6, output: 18, cache_read: 1.5, tier: { type: 'context', size: 200_000 } },
          ],
        },
      },
    },
  },
  'nano-gpt': {
    models: {
      'grok-4.9': { id: 'grok-4.9', cost: { input: 1, output: 1 } },
    },
  },
};

const tokens = {
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1_000_000,
};

describe('models.dev 补价', () => {
  it('目录没有的模型按 models.dev 阶梯计费', () => {
    const catalog = supplementCatalogFromModelsDev(getPricingCatalog(), index, [
      { provider: 'cursor', product: 'cursor', model: 'cursor-grok-4.8-xhigh' },
    ]);
    const priced = calculateCost('cursor', 'cursor', 'cursor-grok-4.8-xhigh', tokens, { catalog });
    expect(priced.costStatus).toBe('estimated');
    expect(priced.resolvedModel).toBe('grok-4.8');
    expect(priced.estimatedCostUsd).toBeCloseTo(16, 4);
    expect(catalog.version).toContain('+models.dev');
  });

  it('Fast 变体使用 models.dev 的独立阶梯', () => {
    const catalog = supplementCatalogFromModelsDev(getPricingCatalog(), index, [
      { provider: 'xai', product: 'grok', model: 'grok-4.8-fast' },
    ]);
    const priced = calculateCost('xai', 'grok', 'grok-4.8-fast', tokens, { catalog });
    expect(priced.resolvedModel).toBe('grok-4.8-fast');
    expect(priced.estimatedCostUsd).toBeCloseTo(24, 4);
  });

  it('已有条目不被 models.dev 覆盖', () => {
    const catalog = supplementCatalogFromModelsDev(getPricingCatalog(), index, [
      { provider: 'xai', product: 'grok', model: 'grok-4.6' },
      { provider: 'xai', product: 'grok', model: 'grok-4.8' },
    ]);
    const existing = calculateCost('xai', 'grok', 'grok-4.6', tokens, { catalog });
    expect(existing.estimatedCostUsd).toBeCloseTo(16, 4);
    expect(existing.costStatus).toBe('exact');
  });

  it('不采用转售商报价，也不把新版本前缀匹配到旧模型', () => {
    const catalog = supplementCatalogFromModelsDev(getPricingCatalog(), index, [
      { provider: 'xai', product: 'grok', model: 'grok-4.9' },
    ]);
    const priced = calculateCost('xai', 'grok', 'grok-4.9', tokens, { catalog });
    expect(priced.costStatus).toBe('unavailable');
    expect(priced.estimatedCostUsd).toBe(0);
    expect(catalog.version).not.toContain('+models.dev');
  });

  it('带构建后缀的型号回退到同一模型，而不是更高版本', () => {
    const catalog = supplementCatalogFromModelsDev(getPricingCatalog(), index, [
      { provider: 'xai', product: 'grok', model: 'grok-4.8-build' },
    ]);
    const priced = calculateCost('xai', 'grok', 'grok-4.8-build', tokens, { catalog });
    expect(priced.resolvedModel).toBe('grok-4.8');
    expect(priced.estimatedCostUsd).toBeCloseTo(16, 4);
  });
});
