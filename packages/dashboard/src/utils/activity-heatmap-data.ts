import type { DailyTrendItem, HeatmapDay } from '@aiusage/shared';
import { computeActivityStreaks, isDayActive } from '@aiusage/shared';

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
