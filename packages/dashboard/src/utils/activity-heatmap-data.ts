import type { DailyTrendItem, HeatmapDay } from '@aiusage/shared';
import { addCalendarDays, computeActivityStreaks, diffCalendarDays, isDayActive, weekdayUtc } from '@aiusage/shared';

export interface ActivityHeatmapDay {
  usageDate: string;
  activityValue: number;
  estimatedCostUsd: number;
  totalTokens: number;
  eventCount: number;
}

export interface ActivityHeatmapData {
  metricLabel: 'tokens' | 'sessions';
  days: ActivityHeatmapDay[];
}

export { addCalendarDays, computeActivityStreaks, isDayActive, weekdayUtc } from '@aiusage/shared';

export type HeatmapLayout = 'day-hour' | 'week-hour' | 'calendar';

export function resolveHeatmapLayout(range: string): HeatmapLayout {
  if (range === 'today' || range === '1d') return 'day-hour';
  if (range === '7d') return 'week-hour';
  return 'calendar';
}

export function resolveRangeStart(
  range: string,
  today: string,
  firstDataDate?: string | null,
): string {
  switch (range) {
    case 'today':
    case '1d':
      return today;
    case '7d':
      return addCalendarDays(today, -6);
    case '30d':
      return addCalendarDays(today, -29);
    case '90d':
    case '3m':
      return addCalendarDays(today, -89);
    case '180d':
    case '6m':
      return addCalendarDays(today, -179);
    case 'month':
      return `${today.slice(0, 7)}-01`;
    case 'year':
    case '1y':
      return `${today.slice(0, 4)}-01-01`;
    case 'all':
      return firstDataDate && firstDataDate <= today ? firstDataDate : today;
    default:
      return addCalendarDays(today, -29);
  }
}

export function resolveHeatmapGrid(today: string, startDate: string): {
  startStr: string;
  endStr: string;
  weeks: number;
} {
  const startStr = addCalendarDays(startDate, -weekdayUtc(startDate));
  const endStr = addCalendarDays(today, 6 - weekdayUtc(today));
  const weeks = Math.max(1, Math.floor(diffCalendarDays(startStr, endStr) / 7) + 1);
  return { startStr, endStr, weeks };
}

export function buildActivityHeatmapData({
  heatmap,
  dailyTrend,
  tokenMetricsUnavailable,
}: {
  heatmap: HeatmapDay[];
  dailyTrend: DailyTrendItem[];
  tokenMetricsUnavailable: boolean;
}): ActivityHeatmapData {
  const heatmapByDate = new Map(heatmap.map((day) => [day.usageDate, day]));
  const trendByDate = new Map(dailyTrend.map((day) => [day.usageDate, day]));
  const usageDates = Array.from(new Set([
    ...heatmap.map((day) => day.usageDate),
    ...dailyTrend.map((day) => day.usageDate),
  ])).sort();

  const days = usageDates.map((usageDate) => {
    const heat = heatmapByDate.get(usageDate);
    const trend = trendByDate.get(usageDate);
    const totalTokens = heat?.totalTokens ?? 0;
    const eventCount = trend?.eventCount ?? 0;
    // Event-only days (0 tokens) still count as activity; otherwise KPI and heatmap disagree.
    const activityValue = tokenMetricsUnavailable
      ? eventCount
      : (totalTokens > 0 ? totalTokens : eventCount);

    return {
      usageDate,
      activityValue,
      estimatedCostUsd: heat?.estimatedCostUsd ?? trend?.estimatedCostUsd ?? 0,
      totalTokens,
      eventCount,
    };
  });

  return {
    metricLabel: tokenMetricsUnavailable ? 'sessions' : 'tokens',
    days,
  };
}

export function countActiveDaysInWindow(
  days: Array<{ usageDate: string; activityValue?: number; eventCount?: number; totalTokens?: number }>,
  startStr: string,
  today: string,
): number {
  return days.filter((day) => (
    day.usageDate >= startStr
    && day.usageDate <= today
    && isDayActive(day)
  )).length;
}
