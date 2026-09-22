import {
  datesFromMonthStartThrough,
  type CostCompositionItem,
  type HourlyCostCompositionItem,
  type HourlyProviderTrendItem,
  type HourlyToolTrendItem,
  type ToolDailyTrendItem,
  type HourlyTokenCompositionItem,
  type HourlyTrendItem,
  type SankeyGraph,
  type TokenCompositionItem,
} from '@aiusage/shared';
import type { OverviewPayload, FiltersState } from '../hooks/use-overview';
import { foldRankedSlices } from './fold';

/** Pad the server's month-scoped series without changing its authoritative aggregates. */
export function padMonth(ov: OverviewPayload): OverviewPayload {
  const today = ov.today
    ?? ov.dailyTrend.map((d) => d.usageDate).sort().at(-1)
    ?? ov.heatmap.map((d) => d.usageDate).sort().at(-1);
  if (!today) return ov;
  const allDates = datesFromMonthStartThrough(today);

  const trendMap = new Map(ov.dailyTrend.map((d) => [d.usageDate, d]));
  const compMap = new Map(ov.tokenComposition.map((d) => [d.usageDate, d]));

  const dailyTrend = allDates.map((date) => trendMap.get(date) ?? { usageDate: date, eventCount: 0, estimatedCostUsd: 0 });
  const tokenComposition = allDates.map((date) => compMap.get(date) ?? {
    usageDate: date, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
  });

  // Filter provider daily trend to current month
  const monthDateSet = new Set(allDates);
  const providerDailyTrend = (ov.providerDailyTrend ?? []).filter(
    (item) => monthDateSet.has(item.usageDate),
  );
  const toolDailyTrend = (ov.toolDailyTrend ?? []).filter(
    (item) => monthDateSet.has(item.usageDate),
  );
  const costComposition = (ov.costComposition ?? []).filter(
    (item) => monthDateSet.has(item.usageDate),
  );

  return {
    ...ov,
    dailyTrend,
    providerDailyTrend,
    toolDailyTrend,
    tokenComposition,
    costComposition,
  };
}

export function buildQuery(f: FiltersState): string {
  const p = new URLSearchParams();
  const aliases: Record<string, string> = {
    deviceIds: 'deviceId',
    products: 'product',
    models: 'model',
    projects: 'project',
  };

  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v)) {
      const key = aliases[k] ?? k;
      v.filter(Boolean).forEach((item) => p.append(key, item));
      continue;
    }
    if (!v) continue;
    p.set(k, v);
  }
  return p.toString();
}

export function transformSankey(input?: SankeyGraph, otherLabel = 'Other') {
  if (!input?.nodes.length || !input?.links.length) return null;

  // Fold only the long tail. Keep unknown / empty-window plus every named
  // project that still has a visible share, so Other does not hide larger repos.
  const MAX_NAMED_TARGETS = 28;
  const MIN_TARGET_RATIO = 0.002;
  const targetIds = new Set(input.links.map((l) => l.target));
  const sourceIds = new Set(input.links.map((l) => l.source));
  const pureTargets = [...targetIds].filter((id) => !sourceIds.has(id));
  const labelOf = (id: string) => input.nodes.find((n) => n.id === id)?.label ?? id;
  const isUnknownTarget = (id: string) => {
    const label = labelOf(id).trim().toLowerCase();
    return label === 'unknown' || label === 'empty-window';
  };

  let nodes = input.nodes;
  let links = input.links;

  if (pureTargets.length > MAX_NAMED_TARGETS + 2) {
    const targetVolume = new Map<string, number>();
    for (const l of links) {
      if (pureTargets.includes(l.target)) {
        targetVolume.set(l.target, (targetVolume.get(l.target) || 0) + Number(l.value || 0));
      }
    }
    const sorted = [...targetVolume.entries()].sort((a, b) => b[1] - a[1]);
    const totalVolume = sorted.reduce((sum, [, value]) => sum + value, 0);
    const floor = totalVolume * MIN_TARGET_RATIO;
    const rankedNamed = sorted.filter(([id]) => !isUnknownTarget(id));
    let namedCount = 0;
    while (namedCount < rankedNamed.length && namedCount < MAX_NAMED_TARGETS) {
      const value = rankedNamed[namedCount]?.[1] ?? 0;
      if (namedCount < 6 || value >= floor) {
        namedCount += 1;
        continue;
      }
      break;
    }
    while (namedCount < rankedNamed.length && namedCount < MAX_NAMED_TARGETS) {
      const other = rankedNamed.slice(namedCount).reduce((sum, [, value]) => sum + value, 0);
      const last = rankedNamed[namedCount - 1]?.[1] ?? 0;
      const next = rankedNamed[namedCount]?.[1] ?? 0;
      if (other > last && next >= floor * 0.5) {
        namedCount += 1;
        continue;
      }
      break;
    }
    const named = rankedNamed.slice(0, namedCount).map(([id]) => id);
    const unknown = sorted.filter(([id]) => isUnknownTarget(id)).map(([id]) => id);
    const keepSet = new Set([...unknown, ...named]);
    const otherId = '__other__';

    nodes = [
      ...input.nodes.filter((n) => !pureTargets.includes(n.id) || keepSet.has(n.id)),
      { id: otherId, label: otherLabel, layer: Math.max(...input.nodes.map((n) => n.layer)), totalTokens: 0 },
    ];
    links = input.links.map((l) =>
      pureTargets.includes(l.target) && !keepSet.has(l.target)
        ? { ...l, target: otherId }
        : l,
    );
  }

  const nodeList = nodes.map((n) => ({
    name: n.label || n.id,
  }));
  const idToIdx = new Map(nodes.map((n, i) => [n.id, i]));

  // Merge duplicate links (same source→target after folding)
  const merged = new Map<string, { source: number; target: number; value: number }>();
  for (const l of links) {
    const si = idToIdx.get(l.source);
    const ti = idToIdx.get(l.target);
    if (si === undefined || ti === undefined || Number(l.value || 0) <= 0) continue;
    const key = `${si}-${ti}`;
    const prev = merged.get(key);
    if (prev) prev.value += Number(l.value);
    else merged.set(key, { source: si, target: ti, value: Number(l.value) });
  }

  const finalLinks = [...merged.values()];
  return finalLinks.length ? { nodes: nodeList, links: finalLinks } : null;
}

export function hourAxisKey(usageDate: string, hour: number): string {
  return `${usageDate}T${String(hour).padStart(2, '0')}`;
}

export function resolveChartAxis(range: string): 'day' | 'hour' {
  return range === 'today' || range === '1d' ? 'hour' : 'day';
}

function padHours(nowHour: number): number[] {
  const last = Math.min(23, Math.max(0, Math.trunc(nowHour)));
  return Array.from({ length: last + 1 }, (_, hour) => hour);
}

export function toHourlyDailyTrend(
  today: string,
  nowHour: number,
  hourly: HourlyTrendItem[] | undefined,
): OverviewPayload['dailyTrend'] {
  const byHour = new Map((hourly ?? []).filter((row) => row.usageDate === today).map((row) => [row.hour, row]));
  return padHours(nowHour).map((hour) => {
    const row = byHour.get(hour);
    return {
      usageDate: hourAxisKey(today, hour),
      eventCount: row?.eventCount ?? 0,
      estimatedCostUsd: row?.estimatedCostUsd ?? 0,
    };
  });
}

export function toHourlyProviderTrend(
  today: string,
  nowHour: number,
  hourly: HourlyProviderTrendItem[] | undefined,
): OverviewPayload['providerDailyTrend'] {
  return (hourly ?? [])
    .filter((row) => row.usageDate === today && row.hour <= nowHour)
    .map((row) => ({
      usageDate: hourAxisKey(row.usageDate, row.hour),
      provider: row.provider,
      estimatedCostUsd: row.estimatedCostUsd,
    }));
}

export function toHourlyToolTrend(
  today: string,
  nowHour: number,
  hourly: HourlyToolTrendItem[] | undefined,
): ToolDailyTrendItem[] {
  return (hourly ?? [])
    .filter((row) => row.usageDate === today && row.hour <= nowHour)
    .map((row) => ({
      usageDate: hourAxisKey(row.usageDate, row.hour),
      tool: row.tool,
      estimatedCostUsd: row.estimatedCostUsd,
    }));
}

export function toHourlyTokenComposition(
  today: string,
  nowHour: number,
  hourly: HourlyTokenCompositionItem[] | undefined,
): TokenCompositionItem[] {
  const empty = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  const byHour = new Map((hourly ?? []).filter((row) => row.usageDate === today).map((row) => [row.hour, row]));
  return padHours(nowHour).map((hour) => {
    const row = byHour.get(hour);
    return {
      usageDate: hourAxisKey(today, hour),
      ...(row
        ? {
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            outputTokens: row.outputTokens,
            reasoningOutputTokens: row.reasoningOutputTokens,
            totalTokens: row.totalTokens,
          }
        : empty),
    };
  });
}

export function selectChartSeries(ov: OverviewPayload | null, range: string): {
  dailyTrend: OverviewPayload['dailyTrend'];
  providerTrend: OverviewPayload['providerDailyTrend'];
  toolTrend: ToolDailyTrendItem[];
  tokenComposition: OverviewPayload['tokenComposition'];
  costComposition: OverviewPayload['costComposition'];
} {
  const today = ov?.today;
  const nowHour = ov?.nowHour ?? 23;
  if (!ov || resolveChartAxis(range) !== 'hour' || !today) {
    return {
      dailyTrend: ov?.dailyTrend ?? [],
      providerTrend: ov?.providerDailyTrend ?? [],
      toolTrend: ov?.toolDailyTrend ?? [],
      tokenComposition: ov?.tokenComposition ?? [],
      costComposition: ov?.costComposition ?? [],
    };
  }
  return {
    dailyTrend: toHourlyDailyTrend(today, nowHour, ov.hourlyTrend),
    providerTrend: toHourlyProviderTrend(today, nowHour, ov.hourlyProviderTrend),
    toolTrend: toHourlyToolTrend(today, nowHour, ov.hourlyToolTrend),
    tokenComposition: toHourlyTokenComposition(today, nowHour, ov.hourlyTokenComposition),
    costComposition: toHourlyCostComposition(today, nowHour, ov.hourlyCostComposition),
  };
}

export function toHourlyCostComposition(
  today: string,
  nowHour: number,
  hourly: HourlyCostCompositionItem[] | undefined,
): CostCompositionItem[] {
  return (hourly ?? [])
    .filter((row) => row.usageDate === today && row.hour <= nowHour)
    .map((row) => ({
      usageDate: hourAxisKey(row.usageDate, row.hour),
      model: row.model,
      estimatedCostUsd: row.estimatedCostUsd,
    }));
}

export function pivotProviderTrend(
  dailyTrend: OverviewPayload['dailyTrend'],
  providerTrend: OverviewPayload['providerDailyTrend'],
): { data: Record<string, unknown>[]; providers: string[] } {
  const providerSet = new Set<string>();
  const dateMap = new Map<string, Record<string, number>>();

  for (const r of providerTrend ?? []) {
    providerSet.add(r.provider);
    const existing = dateMap.get(r.usageDate) ?? {};
    existing[r.provider] = r.estimatedCostUsd;
    dateMap.set(r.usageDate, existing);
  }

  const providers = [...providerSet];
  const data = dailyTrend.map((d) => ({
    usageDate: d.usageDate,
    ...Object.fromEntries(providers.map((p) => [p, dateMap.get(d.usageDate)?.[p] ?? 0])),
  }));

  return { data, providers };
}

export const OTHER_MODEL_KEY = '__other__';

export function pivotModelCost(
  dailyTrend: OverviewPayload['dailyTrend'],
  costComposition: CostCompositionItem[] | undefined,
  options: {
    maxNamed?: number;
    minRatio?: number;
    otherLabel?: string;
  } = {},
): { data: Record<string, unknown>[]; models: string[] } {
  const otherLabel = options.otherLabel ?? 'Other';
  const totals = new Map<string, number>();
  for (const row of costComposition ?? []) {
    if (!row.model) continue;
    totals.set(row.model, (totals.get(row.model) ?? 0) + Number(row.estimatedCostUsd || 0));
  }

  const ranked = [...totals.entries()]
    .filter(([, slice]) => slice > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, slice]) => ({ value: model, label: model, slice }));

  const { rows } = foldRankedSlices(ranked, {
    maxNamed: options.maxNamed ?? 10,
    minRatio: options.minRatio ?? 0.015,
    otherLabel,
  });
  const named = rows.filter((row) => row.value !== 'other').map((row) => row.value);
  const hasOther = rows.some((row) => row.value === 'other');
  const keep = new Set(named);
  const models = hasOther ? [...named, OTHER_MODEL_KEY] : named;

  const dateMap = new Map<string, Record<string, number>>();
  for (const row of costComposition ?? []) {
    if (!row.model) continue;
    const key = keep.has(row.model) ? row.model : OTHER_MODEL_KEY;
    if (!hasOther && key === OTHER_MODEL_KEY) continue;
    const existing = dateMap.get(row.usageDate) ?? {};
    existing[key] = (existing[key] ?? 0) + Number(row.estimatedCostUsd || 0);
    dateMap.set(row.usageDate, existing);
  }

  const data = dailyTrend.map((day) => ({
    usageDate: day.usageDate,
    ...Object.fromEntries(models.map((model) => [model, dateMap.get(day.usageDate)?.[model] ?? 0])),
  }));

  return { data, models };
}
