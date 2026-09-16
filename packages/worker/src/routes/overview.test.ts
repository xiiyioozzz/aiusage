import { describe, expect, it } from 'vitest';
import { buildDailyCostComposition, buildDateWindow, buildPreviousFilters, buildWhere, dateStringInTimeZone, hourInTimeZone, parseFilters, providerDisplaySql, resolveTotalDays } from './overview';

describe('overview filters', () => {
  it('builds inclusive date windows that include today without adding an extra day', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');

    expect(buildDateWindow('today', now)).toEqual({
      minDate: '2026-07-20',
      maxDate: '2026-07-20',
      days: 1,
    });
    expect(buildDateWindow('1d', now)).toEqual({
      minDate: '2026-07-20',
      maxDate: '2026-07-20',
      days: 1,
    });
    expect(buildDateWindow('7d', now)).toEqual({
      minDate: '2026-07-14',
      maxDate: '2026-07-20',
      days: 7,
    });
    expect(buildDateWindow('30d', now)).toEqual({
      minDate: '2026-06-21',
      maxDate: '2026-07-20',
      days: 30,
    });
    expect(buildDateWindow('month', now)).toEqual({
      minDate: '2026-07-01',
      maxDate: '2026-07-20',
      days: 20,
    });
    expect(buildDateWindow('year', now)).toEqual({
      minDate: '2026-01-01',
      maxDate: '2026-07-20',
      days: 201,
    });
  });

  it('compares this year against the same calendar span last year', () => {
    const previous = buildPreviousFilters({
      minDate: '2026-01-01',
      maxDate: '2026-09-15',
      rangeDays: 258,
      range: 'year',
      deviceId: [],
      provider: [],
      product: [],
      channel: [],
      model: [],
      project: [],
    });
    expect(previous).toMatchObject({
      minDate: '2025-01-01',
      maxDate: '2025-09-15',
      range: 'year',
    });
  });

  it('uses the site timezone when UTC is still the previous calendar day', () => {
    const now = new Date('2026-09-14T23:30:00.000Z');

    expect(dateStringInTimeZone(now, 'Asia/Shanghai')).toBe('2026-09-15');
    expect(hourInTimeZone(now, 'Asia/Shanghai')).toBe(7);
    expect(hourInTimeZone(now, 'UTC')).toBe(23);
    expect(buildDateWindow('today', now, 'Asia/Shanghai')).toEqual({
      minDate: '2026-09-15',
      maxDate: '2026-09-15',
      days: 1,
    });
    expect(buildDateWindow('7d', now, 'Asia/Shanghai')).toEqual({
      minDate: '2026-09-09',
      maxDate: '2026-09-15',
      days: 7,
    });
    expect(buildDateWindow('7d', now, 'UTC')).toEqual({
      minDate: '2026-09-08',
      maxDate: '2026-09-14',
      days: 7,
    });
    expect(buildDateWindow('year', now, 'Asia/Shanghai')).toEqual({
      minDate: '2026-01-01',
      maxDate: '2026-09-15',
      days: 258,
    });
  });

  it('counts all-time total days across calendar gaps, not just days with records', () => {
    expect(buildDateWindow('all')).toEqual({ minDate: null, maxDate: null, days: null });
    expect(resolveTotalDays(30, '2026-02-21', '2026-09-15')).toBe(30);
    expect(resolveTotalDays(null, '2026-02-21', '2026-09-15')).toBe(207);
    expect(resolveTotalDays(null, null, '2026-09-15')).toBe(0);
    expect(resolveTotalDays(null, '2026-09-16', '2026-09-15')).toBe(0);
  });

  it('parses repeated and comma-separated facet params as multi-select values', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=30d&product=codex&product=claude-code&model=gpt-5,claude-opus'));

    expect(filters?.product).toEqual(['codex', 'claude-code']);
    expect(filters?.model).toEqual(['gpt-5', 'claude-opus']);
  });

  it('builds IN clauses for multi-selected facets', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=7d&deviceId=mac-a&deviceId=mac-b&project=AIUsage'))!;
    const where = buildWhere(filters);

    expect(where.whereClause).toContain('b.device_id IN (?, ?)');
    expect(where.whereClause).toContain('COALESCE(b.project_alias, b.project_display) = ?');
    expect(where.params).toEqual([expect.any(String), expect.any(String), 'mac-a', 'mac-b', 'AIUsage']);
  });

  it('maps kiro/xkiro channel rows back to the real model vendor', () => {
    expect(providerDisplaySql('b')).toContain("'xkiro'");
    expect(providerDisplaySql('b')).toContain('anthropic');
    expect(providerDisplaySql('b')).not.toContain("product = 'kiro'");

    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=7d&provider=anthropic'))!;
    const where = buildWhere(filters);
    expect(where.whereClause).toContain(providerDisplaySql('b'));
    expect(where.params).toContain('anthropic');
  });
});

describe('buildDailyCostComposition', () => {
  it('aggregates stored cost by date and model', () => {
    expect(buildDailyCostComposition([
      { usage_date: '2026-09-15', model: 'claude-sonnet-4-6', estimated_cost_usd: 10 },
      { usage_date: '2026-09-15', model: 'gpt-5.4', estimated_cost_usd: 4 },
      { usage_date: '2026-09-15', model: 'claude-sonnet-4-6', estimated_cost_usd: 2 },
      { usage_date: '2026-09-14', model: 'gpt-5.4', estimated_cost_usd: 1 },
      { usage_date: '2026-09-14', model: '', estimated_cost_usd: 9 },
      { usage_date: '2026-09-13', model: 'gpt-5.4', estimated_cost_usd: 0 },
    ])).toEqual([
      { usageDate: '2026-09-14', model: 'gpt-5.4', estimatedCostUsd: 1 },
      { usageDate: '2026-09-15', model: 'claude-sonnet-4-6', estimatedCostUsd: 12 },
      { usageDate: '2026-09-15', model: 'gpt-5.4', estimatedCostUsd: 4 },
    ]);
  });
});
