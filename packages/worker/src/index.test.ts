import { describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import type { Env } from './types.js';

function environment(publicHost?: string) {
  return {
    PUBLIC_HOST: publicHost,
    SITE_ID: 'test-site',
    ASSETS: { fetch: vi.fn(async () => new Response('this deployment')) },
  } as unknown as Env;
}

describe('optional workers.dev canonical host', () => {
  it('serves an independent deployment when PUBLIC_HOST is unset', async () => {
    const response = await worker.fetch(new Request('https://new-owner.workers.dev/'), environment());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('this deployment');
  });

  it('redirects dashboard pages to the configured host and retains path and query', async () => {
    const response = await worker.fetch(new Request('https://new-owner.workers.dev/pricing?view=all'), environment('dashboard.example.com'));
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://dashboard.example.com/pricing?view=all');
  });

  it('keeps API requests on workers.dev and does not redirect custom-domain traffic', async () => {
    const env = environment('dashboard.example.com');
    const health = await worker.fetch(new Request('https://new-owner.workers.dev/api/v1/health'), env);
    expect(health.status).toBe(200);
    expect(health.headers.get('Location')).toBeNull();
    const dashboard = await worker.fetch(new Request('https://dashboard.example.com/'), env);
    expect(await dashboard.text()).toBe('this deployment');
  });
});
