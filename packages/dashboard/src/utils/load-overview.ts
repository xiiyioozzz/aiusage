import type { FiltersState, HealthPayload, OverviewPayload } from '../hooks/use-overview';
import { buildQuery, padMonth } from './data';

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error('Response is not JSON');
  }
  return response.json() as Promise<T>;
}

export async function loadOverview(
  filters: FiltersState,
  { demo = false, fetchImpl = fetch }: { demo?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ overview: OverviewPayload; health: HealthPayload; isDemo: boolean }> {
  // Demo is an explicit build/development option, never an API error fallback.
  if (demo) {
    const { DEMO_OVERVIEW, DEMO_HEALTH } = await import('../demo-data');
    return { overview: DEMO_OVERVIEW, health: DEMO_HEALTH, isDemo: true };
  }

  const [overview, health] = await Promise.all([
    fetchJson<OverviewPayload>(`/api/v1/public/overview?${buildQuery(filters)}`, fetchImpl),
    fetchJson<HealthPayload>('/api/v1/health', fetchImpl).catch(
      () => ({ ok: false, siteId: 'unknown', version: 'unknown' }),
    ),
  ]);
  if (!overview.ok) throw new Error('Overview request failed');
  return {
    overview: filters.range === 'month' ? padMonth(overview) : overview,
    health,
    isDemo: false,
  };
}
