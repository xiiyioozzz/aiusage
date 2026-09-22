import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestActivityItem, IngestBreakdown, IngestDay } from '@aiusage/shared';
import { createTestDatabase } from '../__tests__/d1-test-utils.js';
import { signDeviceToken } from '../utils/token.js';
import { handleIngest, handleReprice } from './ingest.js';
import { handleOverview } from './overview.js';

const usageDate = '2026-09-17';
const codex: IngestBreakdown = {
  provider: 'openai', product: 'codex', channel: 'cli', model: 'gpt-5.5',
  project: 'fixture', eventCount: 1, inputTokens: 0, cachedInputTokens: 0,
  cacheWriteTokens: 0, outputTokens: 100, reasoningOutputTokens: 900,
};
const claude: IngestBreakdown = {
  ...codex, provider: 'anthropic', product: 'claude-code', model: 'claude-sonnet-4-6',
};
function activity(breakdown: IngestBreakdown, count: number): IngestActivityItem {
  return {
    provider: breakdown.provider, product: breakdown.product,
    source: `${breakdown.provider}/${breakdown.product}`, project: breakdown.project,
    kind: 'user_message', name: 'message', confidence: 'exact', count,
  };
}

describe('ingest and public queries against the migration schema', () => {
  let fixture: ReturnType<typeof createTestDatabase>;
  let token: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
    fixture = createTestDatabase();
    fixture.sqlite.prepare(`
      INSERT INTO devices (device_id, timezone, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
    `).run('device-a', 'UTC', usageDate, usageDate);
    token = await signDeviceToken({
      siteId: 'test-site', deviceId: 'device-a', tokenVersion: 1, issuedAt: usageDate,
    }, fixture.env.DEVICE_TOKEN_SECRET);
  });

  afterEach(() => {
    fixture.sqlite.close();
    vi.useRealTimers();
  });

  async function ingest(day: IngestDay) {
    const response = await handleIngest(new Request('https://example.test/api/v1/ingest/daily', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        siteId: 'test-site', schemaVersion: '1.0',
        device: { deviceId: 'device-a', appVersion: 'test' }, days: [day],
      }),
    }), fixture.env);
    expect(response.status).toBe(200);
  }

  function activityCounts() {
    return fixture.sqlite.prepare(`
      SELECT product, SUM(event_count) AS count FROM daily_activity_breakdown GROUP BY product ORDER BY product
    `).all().map(row => ({ ...row }));
  }

  it('returns provider-filtered activity and comparisons without querying a nonexistent model column', async () => {
    await ingest({ usageDate, breakdowns: [codex, claude], activity: { items: [activity(codex, 3), activity(claude, 5)] } });
    const response = await handleOverview(
      new URL('https://example.test/api/v1/public/overview?range=year&provider=anthropic'), fixture.env,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { interactionMetrics: { userMessageCount: number }; comparison: { userMessageCount: number } };
    expect(payload.interactionMetrics.userMessageCount).toBe(5);
    expect(payload.comparison.userMessageCount).toBe(0);
  });

  it('preserves all existing activity when a token-only import omits activity', async () => {
    await ingest({ usageDate, breakdowns: [codex, claude], activity: { items: [activity(codex, 3), activity(claude, 5)] } });
    await ingest({ usageDate, breakdowns: [claude] });
    expect(activityCounts()).toEqual([{ product: 'claude-code', count: 5 }, { product: 'codex', count: 3 }]);
  });

  it('replaces only products in an explicit activity update', async () => {
    await ingest({ usageDate, breakdowns: [codex, claude], activity: { items: [activity(codex, 3), activity(claude, 5)] } });
    await ingest({ usageDate, breakdowns: [claude], activity: { items: [activity(claude, 7)] } });
    expect(activityCounts()).toEqual([{ product: 'claude-code', count: 7 }, { product: 'codex', count: 3 }]);
    await ingest({ usageDate, breakdowns: [claude], activity: { items: [] } });
    expect(activityCounts()).toEqual([{ product: 'codex', count: 3 }]);
  });

  it('accepts activity-only updates while preserving other products', async () => {
    await ingest({ usageDate, breakdowns: [codex, claude], activity: { items: [activity(codex, 3), activity(claude, 5)] } });
    await ingest({ usageDate, breakdowns: [], activity: { items: [activity(codex, 8)] } });
    expect(activityCounts()).toEqual([{ product: 'claude-code', count: 5 }, { product: 'codex', count: 8 }]);
    await ingest({ usageDate, breakdowns: [], activity: { items: [] } });
    expect(activityCounts()).toHaveLength(2);
  });

  it('reprices each hour and the daily total while preserving the product filter', async () => {
    await ingest({
      usageDate, breakdowns: [{ ...codex, eventCount: 2, outputTokens: 200, reasoningOutputTokens: 1800 }, claude],
      hourly: [{ hour: 9, breakdowns: [codex, claude] }, { hour: 10, breakdowns: [codex] }],
    });
    fixture.sqlite.exec('UPDATE daily_usage_breakdown SET estimated_cost_usd = 99');
    fixture.sqlite.exec('UPDATE hourly_usage_breakdown SET estimated_cost_usd = 99');
    const response = await handleReprice(new Request('https://example.test/api/v1/ingest/reprice?product=codex', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }), fixture.env);
    expect(await response.json()).toMatchObject({ ok: true, rowsUpdated: 1, hourlyRowsUpdated: 2, daysUpdated: 1 });
    expect(fixture.sqlite.prepare("SELECT estimated_cost_usd AS cost FROM daily_usage_breakdown WHERE product = 'codex'").get()?.cost).toBe(0.06);
    expect(fixture.sqlite.prepare("SELECT estimated_cost_usd AS cost FROM hourly_usage_breakdown WHERE product = 'codex' ORDER BY usage_hour").all().map(row => row.cost)).toEqual([0.03, 0.03]);
    expect(fixture.sqlite.prepare("SELECT estimated_cost_usd AS cost FROM daily_usage_breakdown WHERE product = 'claude-code'").get()?.cost).toBe(99);
    expect(fixture.sqlite.prepare("SELECT estimated_cost_usd AS cost FROM hourly_usage_breakdown WHERE product = 'claude-code'").get()?.cost).toBe(99);
    expect(fixture.sqlite.prepare('SELECT estimated_cost_usd AS cost FROM daily_usage').get()?.cost).toBe(99.06);
  });

  it('splits grok-bot from cursor in tool trend and product filters', async () => {
    const cursorGrok: IngestBreakdown = {
      ...codex, provider: 'cursor', product: 'cursor', channel: 'ide',
      model: 'cursor-grok-4.6-xhigh-fast', project: 'unknown',
      eventCount: 2, inputTokens: 1000, outputTokens: 200, reasoningOutputTokens: 0,
    };
    const cursorComposer: IngestBreakdown = {
      ...cursorGrok, model: 'composer-2.5-fast', eventCount: 1, inputTokens: 100, outputTokens: 50,
    };
    const grokBot: IngestBreakdown = {
      ...cursorGrok, model: 'grok-bot-default', project: 'empty-window',
      eventCount: 5, inputTokens: 2000, outputTokens: 400,
    };
    await ingest({
      usageDate,
      breakdowns: [codex, cursorGrok, cursorComposer, grokBot],
      hourly: [{ hour: 12, breakdowns: [codex, cursorGrok, cursorComposer, grokBot] }],
    });

    const overview = async (query = '') => {
      const response = await handleOverview(
        new URL(`https://example.test/api/v1/public/overview?range=all${query}`),
        fixture.env,
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        toolDailyTrend: Array<{ tool: string; estimatedCostUsd: number }>;
        providerDailyTrend: Array<{ provider: string; estimatedCostUsd: number }>;
        hourlyToolTrend?: Array<{ tool: string }>;
        filters: { options: { products: Array<{ value: string }>; providers: Array<{ value: string }> } };
      }>;
    };

    const all = await overview();
    expect(all.toolDailyTrend.map((row) => row.tool).sort()).toEqual(['codex', 'cursor', 'grok-bot']);
    expect(all.providerDailyTrend.map((row) => row.provider).sort()).toEqual(['cursor', 'openai', 'xai']);
    expect(all.filters.options.products.map((row) => row.value)).toEqual(
      expect.arrayContaining(['codex', 'cursor', 'grok-bot']),
    );
    expect(all.filters.options.providers.map((row) => row.value)).toEqual(
      expect.arrayContaining(['cursor', 'openai', 'xai']),
    );

    const xaiOnly = await overview('&provider=xai');
    expect(xaiOnly.providerDailyTrend.map((row) => row.provider)).toEqual(['xai']);
    expect(xaiOnly.toolDailyTrend.map((row) => row.tool).sort()).toEqual(['cursor', 'grok-bot']);

    const grokOnly = await overview('&product=grok-bot');
    expect(grokOnly.toolDailyTrend.map((row) => row.tool)).toEqual(['grok-bot']);
    expect(grokOnly.toolDailyTrend[0]?.estimatedCostUsd).toBeGreaterThan(0);

    const cursorOnly = await overview('&product=cursor');
    expect(cursorOnly.toolDailyTrend.map((row) => row.tool)).toEqual(['cursor']);
    expect(cursorOnly.toolDailyTrend.some((row) => row.tool === 'grok-bot')).toBe(false);
  });

  it('clears a replaced product when the snapshot is empty', async () => {
    const cursor: IngestBreakdown = {
      ...codex, provider: 'cursor', product: 'cursor', channel: 'ide', model: 'cursor-grok-4.6-high-fast',
      project: 'unknown', eventCount: 12, outputTokens: 400, reasoningOutputTokens: 0,
    };
    await ingest({ usageDate, breakdowns: [codex, cursor] });
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM daily_usage_breakdown WHERE product = 'cursor'").get()?.n).toBe(1);

    await ingest({ usageDate, breakdowns: [codex], replacedProducts: ['cursor'] });
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM daily_usage_breakdown WHERE product = 'cursor'").get()?.n).toBe(0);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM daily_usage_breakdown WHERE product = 'codex'").get()?.n).toBe(1);
    expect(fixture.sqlite.prepare('SELECT event_count AS n FROM daily_usage').get()?.n).toBe(1);
  });

  it('preserves estimated token quality through storage, filtered summaries, and repricing', async () => {
    const estimated = { ...claude, tokenQuality: 'estimated' as const };
    await ingest({ usageDate, breakdowns: [codex, estimated], hourly: [{ hour: 9, breakdowns: [codex, estimated] }] });
    const overview = async (product: string) => {
      const response = await handleOverview(new URL(`https://example.test/api/v1/public/overview?range=all&product=${product}`), fixture.env);
      return response.json() as Promise<{ estimatedTokenCount: number }>;
    };
    expect((await overview('claude-code')).estimatedTokenCount).toBe(1000);
    expect((await overview('codex')).estimatedTokenCount).toBe(0);

    const response = await handleReprice(new Request('https://example.test/api/v1/ingest/reprice', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }), fixture.env);
    expect(response.status).toBe(200);
    for (const table of ['daily_usage_breakdown', 'hourly_usage_breakdown']) {
      const row = fixture.sqlite.prepare(`SELECT cost_status, extra_metrics_json FROM ${table} WHERE product = 'claude-code'`).get();
      expect(row?.cost_status).toBe('estimated');
      expect(JSON.parse(String(row?.extra_metrics_json)).token_quality).toBe('estimated');
    }
  });
});
