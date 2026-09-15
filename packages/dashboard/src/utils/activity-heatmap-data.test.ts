import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActivityHeatmapData,
  computeActivityStreaks,
  countActiveDaysInWindow,
} from './activity-heatmap-data';

test('uses daily event counts for event-only products when token data is unavailable', () => {
  const result = buildActivityHeatmapData({
    heatmap: [
      { usageDate: '2026-04-01', totalTokens: 0, estimatedCostUsd: 0 },
      { usageDate: '2026-04-02', totalTokens: 0, estimatedCostUsd: 0 },
    ],
    dailyTrend: [
      { usageDate: '2026-04-01', eventCount: 7, estimatedCostUsd: 0 },
      { usageDate: '2026-04-02', eventCount: 2, estimatedCostUsd: 0 },
    ],
    tokenMetricsUnavailable: true,
  });

  assert.equal(result.metricLabel, 'sessions');
  assert.equal(result.days[0]?.activityValue, 7);
  assert.equal(result.days[1]?.activityValue, 2);
});

test('keeps token values for standard token-bearing products', () => {
  const result = buildActivityHeatmapData({
    heatmap: [
      { usageDate: '2026-04-01', totalTokens: 1200, estimatedCostUsd: 1.25 },
    ],
    dailyTrend: [
      { usageDate: '2026-04-01', eventCount: 3, estimatedCostUsd: 1.25 },
    ],
    tokenMetricsUnavailable: false,
  });

  assert.equal(result.metricLabel, 'tokens');
  assert.equal(result.days[0]?.activityValue, 1200);
  assert.equal(result.days[0]?.estimatedCostUsd, 1.25);
});

test('counts a 0-token event day so heatmap active days match the KPI', () => {
  const result = buildActivityHeatmapData({
    heatmap: [
      { usageDate: '2026-04-06', totalTokens: 0, estimatedCostUsd: 0 },
      { usageDate: '2026-04-07', totalTokens: 800, estimatedCostUsd: 3 },
    ],
    dailyTrend: [
      { usageDate: '2026-04-06', eventCount: 1, estimatedCostUsd: 0 },
      { usageDate: '2026-04-07', eventCount: 57, estimatedCostUsd: 3 },
    ],
    tokenMetricsUnavailable: false,
  });

  assert.equal(result.days[0]?.activityValue, 1);
  assert.equal(countActiveDaysInWindow(result.days, '2026-04-01', '2026-04-07'), 2);
});

test('keeps the current streak alive when today has no activity yet', () => {
  const days = [
    { usageDate: '2026-09-13', activityValue: 10 },
    { usageDate: '2026-09-14', activityValue: 20 },
  ];

  assert.deepEqual(computeActivityStreaks(days, '2026-09-15'), {
    streak: 2,
    longestStreak: 2,
  });
});

test('starts the current streak from today when today already has activity', () => {
  const days = [
    { usageDate: '2026-09-13', activityValue: 10 },
    { usageDate: '2026-09-14', activityValue: 20 },
    { usageDate: '2026-09-15', activityValue: 5 },
  ];

  assert.deepEqual(computeActivityStreaks(days, '2026-09-15'), {
    streak: 3,
    longestStreak: 3,
  });
});

test('resets the current streak after a missed full day', () => {
  const days = [
    { usageDate: '2026-09-12', activityValue: 10 },
    { usageDate: '2026-09-13', activityValue: 10 },
  ];

  assert.deepEqual(computeActivityStreaks(days, '2026-09-15'), {
    streak: 0,
    longestStreak: 2,
  });
});
