import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_OVERVIEW } from '../demo-data';
import { loadOverview } from './load-overview';

const filters = { range: '30d' };

test('API errors never substitute demo data without explicit opt-in', async () => {
  for (const status of [401, 500, 503]) {
    await assert.rejects(
      loadOverview(filters, { fetchImpl: async () => new Response(null, { status }) }),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test('network errors and HTML fallback responses remain load failures', async () => {
  await assert.rejects(
    loadOverview(filters, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    /Failed to fetch/,
  );
  await assert.rejects(
    loadOverview(filters, { fetchImpl: async () => new Response('<html>offline</html>', { headers: { 'content-type': 'text/html' } }) }),
    /Response is not JSON/,
  );
});

test('a failed overview payload is not treated as a successful data load', async () => {
  await assert.rejects(
    loadOverview(filters, { fetchImpl: async () => Response.json({ ok: false }) }),
    /Overview request failed/,
  );
});

test('health failure does not discard a successful live overview', async () => {
  const urls: string[] = [];
  const result = await loadOverview({ range: '30d', models: ['gpt-5.5'] }, {
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/health')) return new Response(null, { status: 503 });
      return Response.json(DEMO_OVERVIEW);
    },
  });
  assert.equal(result.isDemo, false);
  assert.deepEqual(result.overview, DEMO_OVERVIEW);
  assert.equal(result.health.ok, false);
  assert.ok(urls.includes('/api/v1/public/overview?range=30d&model=gpt-5.5'));
});

test('explicit demo mode labels fixed samples and never contacts the API', async () => {
  let fetchCount = 0;
  const result = await loadOverview(filters, {
    demo: true,
    fetchImpl: async () => { fetchCount += 1; throw new Error('Unexpected request'); },
  });
  assert.equal(fetchCount, 0);
  assert.equal(result.isDemo, true);
  assert.deepEqual(result.overview, DEMO_OVERVIEW);
});
