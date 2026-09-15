import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuery, padMonth, transformSankey } from './data';
import { foldRankedSlices } from './fold';

test('buildQuery encodes multi-select filters as repeated params', () => {
  const query = buildQuery({
    range: '30d',
    products: ['codex', 'claude-code'],
    models: ['gpt-5.5', 'gpt-5.4-mini'],
    projects: ['aiusage'],
    deviceIds: ['mbp-16', 'us1'],
  });

  const params = new URLSearchParams(query);
  assert.equal(params.get('range'), '30d');
  assert.deepEqual(params.getAll('product'), ['codex', 'claude-code']);
  assert.deepEqual(params.getAll('model'), ['gpt-5.5', 'gpt-5.4-mini']);
  assert.deepEqual(params.getAll('project'), ['aiusage']);
  assert.deepEqual(params.getAll('deviceId'), ['mbp-16', 'us1']);
});

test('buildQuery keeps month range for the API', () => {
  const query = buildQuery({ range: 'month', products: [] });
  assert.equal(new URLSearchParams(query).get('range'), 'month');
});

test('sankey keeps named projects instead of folding them all into Other', () => {
  const nodes = [
    { id: 'model-a', label: 'model-a', layer: 0, totalTokens: 100 },
    { id: 'project-unknown', label: 'unknown', layer: 1, totalTokens: 80 },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `project-repo-${i}`,
      label: i === 3 ? 'aiusage' : i === 5 ? 'dajuai-vip' : `repo-${i}`,
      layer: 1,
      totalTokens: i < 12 ? 40 - i : 1,
    })),
  ];
  const links = nodes
    .filter((n) => n.layer === 1)
    .map((n) => ({ source: 'model-a', target: n.id, value: n.totalTokens }));

  const sankey = transformSankey({ nodes, links });
  assert.ok(sankey);
  const names = sankey.nodes.map((n) => n.name);
  assert.ok(names.includes('unknown'));
  assert.ok(names.includes('aiusage'));
  assert.ok(names.includes('dajuai-vip'));
  assert.ok(names.includes('Other'));
});

test('foldRankedSlices keeps mid-size projects out of Other', () => {
  const items = [
    { value: 'unknown', label: 'unknown', slice: 2400 },
    { value: 'kiro-go', label: 'kiro-go', slice: 850 },
    { value: 'kirors', label: 'kirors', slice: 30 },
    { value: 'empty-window', label: 'empty-window', slice: 29 },
    { value: 'ban', label: 'ban', slice: 26 },
    { value: 'daju', label: 'daju', slice: 25 },
    ...Array.from({ length: 40 }, (_, i) => ({
      value: `tiny-${i}`,
      label: `tiny-${i}`,
      slice: 1,
    })),
  ];
  const { rows, hidden } = foldRankedSlices(items, {
    maxNamed: 27,
    minRatio: 0.002,
    otherLabel: '其余项目',
  });
  const labels = rows.map((row) => row.label);
  assert.ok(labels.includes('empty-window'));
  assert.ok(labels.includes('ban'));
  assert.ok(labels.includes('daju'));
  assert.ok(labels.includes('其余项目'));
  assert.ok(hidden.some((row) => row.value.startsWith('tiny-')));
  assert.ok(!hidden.some((row) => row.value === 'empty-window'));
});

test('padMonth keeps server active/total days and stops at site today', () => {
  const ov = {
    ok: true,
    today: '2026-09-15',
    totalDays: 15,
    activeDays: 14,
    totalEvents: 3,
    totalSessions: 1,
    costBearingEvents: 2,
    totalCostUsd: 1,
    averageDailyCostUsd: 0.07,
    dailyTrend: [
      { usageDate: '2026-09-01', eventCount: 2, estimatedCostUsd: 1 },
      { usageDate: '2026-09-15', eventCount: 1, estimatedCostUsd: 0 },
    ],
    providerDailyTrend: [],
    tokenComposition: [],
    modelCostShare: [],
    channelCostShare: [],
    sankey: { nodes: [], links: [] },
    heatmap: [],
    filters: {
      selection: { range: 'month', deviceId: [], provider: [], product: [], channel: [], model: [], project: [] },
      options: { devices: [], providers: [], products: [], channels: [], models: [], projects: [] },
    },
  };

  const padded = padMonth(ov);
  assert.equal(padded.totalDays, 15);
  assert.equal(padded.activeDays, 14);
  assert.equal(padded.dailyTrend.length, 15);
  assert.equal(padded.dailyTrend[0]?.usageDate, '2026-09-01');
  assert.equal(padded.dailyTrend.at(-1)?.usageDate, '2026-09-15');
});
