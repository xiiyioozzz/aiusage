import { useEffect, useMemo, useState } from 'react';
import type { OverviewResponse } from '@aiusage/shared';
import { arrSum } from '../utils/format';
import { loadOverview } from '../utils/load-overview';
import { getMetricAvailability } from '../utils/metric-availability';

// ── Types ──

export interface FiltersState {
  range: string;
  deviceId?: string;
  product?: string;
  deviceIds?: string[];
  products?: string[];
  models?: string[];
  projects?: string[];
}

export interface HealthPayload { ok: boolean; siteId: string; version: string; siteTitle?: string }
export interface OverviewPayload extends OverviewResponse { ok: boolean }
export interface FacetOption { value: string; label: string; estimatedCostUsd?: number; eventCount?: number }

// ── Hook ──

export function useOverview(filters: FiltersState) {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [isDemo, setIsDemo] = useState(false);

  // Production failures remain visible; sample data requires explicit opt-in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await loadOverview(filters, { demo: import.meta.env.VITE_DEMO_MODE === 'true' });
        if (cancelled) return;
        setOverview(result.overview);
        setHealth(result.health);
        setIsDemo(result.isDemo);
      } catch (err) {
        if (cancelled) return;
        setOverview(null);
        setHealth(null);
        setIsDemo(false);
        setError(err instanceof Error ? err.message : 'Request failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filters, tick]);

  // Derived KPIs
  const kpis = useMemo(() => {
    if (!overview) return null;
    const tc = overview.tokenComposition;
    const totalTokens = arrSum(tc.map((d) => d.totalTokens));
    const inputTokens = arrSum(tc.map((d) => d.inputTokens));
    const outputTokens = arrSum(tc.map((d) => d.outputTokens + d.reasoningOutputTokens));
    const cachedTokens = arrSum(tc.map((d) => d.cachedInputTokens));
    const denominator = inputTokens + cachedTokens;
    const cacheHitRate = denominator > 0 ? (cachedTokens / denominator) * 100 : 0;
    return { totalTokens, inputTokens, outputTokens, cachedTokens, cacheHitRate };
  }, [overview]);

  const metricAvailability = useMemo(() => {
    if (!overview || !kpis) {
      return { mode: 'standard' as const, tokenMetricsUnavailable: false };
    }

    return getMetricAvailability({
      selectedProduct: filters.products?.length ? filters.products : overview.filters.selection.product,
      productOptions: overview.filters.options.products,
      totalEvents: overview.totalEvents,
      totalTokens: kpis.totalTokens,
    });
  }, [overview, kpis, filters.products]);

  // Filter options
  const fOpts = useMemo(() => ({
    devices: overview?.filters.options.devices ?? [],
    models: overview?.filters.options.models ?? [],
    products: overview?.filters.options.products ?? [],
    projects: overview?.filters.options.projects ?? [],
  }), [overview]);

  const refresh = () => setTick((n) => n + 1);

  return {
    overview,
    health,
    kpis,
    metricAvailability,
    fOpts,
    loading,
    error,
    isDemo,
    refresh,
  };
}
