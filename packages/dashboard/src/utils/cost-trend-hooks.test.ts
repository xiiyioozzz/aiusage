import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

test('cost trend keeps its hook order when empty data becomes populated', async () => {
  const require = createRequire(import.meta.url);
  const React = require('react') as typeof import('react');
  const { renderToString } = require('react-dom/server') as typeof import('react-dom/server');
  const originalStore = React.useSyncExternalStore;

  // Give the browser-only dark-mode store a server snapshot for this render test.
  React.useSyncExternalStore = (subscribe, getSnapshot) => originalStore(subscribe, getSnapshot, getSnapshot);
  Object.assign(globalThis, {
    React,
    document: { documentElement: { classList: { contains: () => false } } },
    localStorage: { getItem: () => null },
  });
  try {
    const { CostTrendChart } = await import('../components/cost-trend-chart');
    function DataTransition() {
      const [populated, setPopulated] = React.useState(false);
      if (!populated) setPopulated(true);
      // Render-phase update exercises both data states on the same hook list.
      return CostTrendChart({
        data: populated ? [{ usageDate: '2026-09-17', eventCount: 1, estimatedCostUsd: 1 }] : [],
        providerTrend: [],
      });
    }
    assert.doesNotThrow(() => renderToString(React.createElement(DataTransition)));
  } finally {
    React.useSyncExternalStore = originalStore;
  }
});
