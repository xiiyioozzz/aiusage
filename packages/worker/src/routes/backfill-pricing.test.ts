import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../__tests__/d1-test-utils.js';
import { backfillUnpricedModels } from './backfill-pricing.js';
import { resetModelsDevCache, type ModelsDevIndex } from '@aiusage/shared';

const now = '2026-09-22T04:00:00.000Z';

function seed(sqlite: ReturnType<typeof createTestDatabase>['sqlite'], model: string, provider = 'cursor', product = 'cursor') {
  sqlite.prepare(`
    INSERT INTO devices (device_id, timezone, first_seen_at, last_seen_at)
    VALUES ('device-a', 'UTC', ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO daily_usage (
      device_id, usage_date, event_count, input_tokens, output_tokens,
      estimated_cost_usd, cost_status, created_at, updated_at
    ) VALUES ('device-a', '2026-09-22', 1, 1000000, 1000000, 0, 'unavailable', ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO daily_usage_breakdown (
      device_id, usage_date, provider, product, channel, model, project,
      event_count, input_tokens, output_tokens, estimated_cost_usd, cost_status,
      created_at, updated_at
    ) VALUES ('device-a', '2026-09-22', ?, ?, 'ide', ?, 'aiusage', 1, 1000000, 1000000, 0, 'unavailable', ?, ?)
  `).run(provider, product, model, now, now);
}

describe('backfillUnpricedModels', () => {
  afterEach(() => {
    resetModelsDevCache();
  });

  it('reprices a stored model once the bundled catalog knows it', async () => {
    const fixture = createTestDatabase();
    seed(fixture.sqlite, 'cursor-grok-4.7-xhigh');
    const updated = await backfillUnpricedModels(fixture.env);
    expect(updated).toBe(1);
    const row = fixture.sqlite.prepare(`
      SELECT estimated_cost_usd AS cost, cost_status AS status
      FROM daily_usage_breakdown
    `).get() as { cost: number; status: string };
    expect(row.cost).toBeCloseTo(16, 4);
    expect(row.status).toBe('estimated');
    const day = fixture.sqlite.prepare('SELECT estimated_cost_usd AS cost FROM daily_usage').get() as { cost: number };
    expect(day.cost).toBeCloseTo(16, 4);
  });

  it('pulls a missing model from models.dev and prices the stored row', async () => {
    const fixture = createTestDatabase();
    seed(fixture.sqlite, 'grok-4.8', 'xai', 'grok');
    const index: ModelsDevIndex = {
      xai: {
        models: {
          'grok-4.8': {
            id: 'grok-4.8',
            cost: {
              input: 2,
              output: 6,
              cache_read: 0.5,
              tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: 'context', size: 200_000 } }],
            },
          },
        },
      },
    };
    const fetchImpl = (async () => new Response(JSON.stringify(index), { status: 200 })) as typeof fetch;
    const updated = await backfillUnpricedModels(fixture.env, fetchImpl);
    expect(updated).toBe(1);
    const row = fixture.sqlite.prepare('SELECT estimated_cost_usd AS cost FROM daily_usage_breakdown').get() as { cost: number };
    expect(row.cost).toBeCloseTo(16, 4);
  });
});
