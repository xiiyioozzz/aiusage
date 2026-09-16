import { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from './ui/chart';
import type { OverviewPayload } from '../hooks/use-overview';
import { getChartColors } from '../constants';
import { formatModelName, formatUsd, formatUsdFull, isHourAxisKey, shortDate, longDate } from '../utils/format';
import { OTHER_MODEL_KEY, pivotModelCost } from '../utils/data';
import { EmptyState, ChartLegend } from './chart-helpers';
import { useIsDark } from '../hooks/use-dark';
import type { CurrencyMode } from '../hooks/use-cny-rate';

export function CostCompositionChart({
  data,
  costComposition,
  currency = 'auto',
  otherLabel = 'Other',
  totalLabel = 'Total',
}: {
  data: OverviewPayload['dailyTrend'];
  costComposition: OverviewPayload['costComposition'];
  currency?: CurrencyMode;
  otherLabel?: string;
  totalLabel?: string;
}) {
  const isDark = useIsDark();
  const { data: pivoted, models } = useMemo(
    () => pivotModelCost(data, costComposition, { otherLabel }),
    [data, costComposition, otherLabel],
  );

  if (!data.length || !models.length) return <EmptyState label="No data" />;

  const hourly = data.some((row) => isHourAxisKey(row.usageDate));
  const barW = hourly ? 18 : data.length <= 7 ? 94 : data.length <= 30 ? 47 : 20;
  const colors = getChartColors(isDark);
  const labels = Object.fromEntries(
    models.map((model) => [model, model === OTHER_MODEL_KEY ? otherLabel : formatModelName(model)]),
  );

  const config = Object.fromEntries(
    models.map((model, i) => [model, { label: labels[model], color: colors[i % colors.length] }]),
  ) satisfies ChartConfig;

  return (
    <>
      <ChartContainer config={config} className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={pivoted} margin={{ top: 12, left: 4, right: 12, bottom: 0 }} barSize={barW}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-white/[0.06]" />
            <XAxis
              dataKey="usageDate" tickLine={false} axisLine={false}
              tickMargin={12} tickFormatter={shortDate} minTickGap={36}
              className="fill-slate-400 dark:fill-slate-500" fontSize={11}
            />
            <YAxis
              tickLine={false} axisLine={false} width={48} tickMargin={8}
              tickFormatter={(v) => formatUsd(Number(v), currency)} className="fill-slate-400 dark:fill-slate-500" fontSize={11}
            />
            <ChartTooltip
              cursor={{ fill: isDark ? 'rgba(51,65,85,0.3)' : '#f8fafc' }}
              content={
                <ChartTooltipContent
                  labelFormatter={longDate}
                  formatter={(v) => formatUsdFull(Number(v), currency)}
                  showTotal
                  totalLabel={totalLabel}
                  totalFormatter={(v) => formatUsdFull(v, currency)}
                />
              }
            />
            {models.map((model, i) => (
              <Bar
                key={model}
                dataKey={model}
                name={labels[model]}
                stackId="cost-model"
                fill={colors[i % colors.length]}
                radius={i === models.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
      <ChartLegend
        items={models.map((model, i) => ({
          label: labels[model] ?? model,
          color: colors[i % colors.length],
        }))}
      />
    </>
  );
}
