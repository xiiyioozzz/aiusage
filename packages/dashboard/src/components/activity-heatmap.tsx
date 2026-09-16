import { useEffect, useMemo, useRef, useState } from 'react';
import type { HourlyHeatmapItem } from '@aiusage/shared';
import type { Locale } from '../i18n';
import { useIsDark } from '../hooks/use-dark';
import type { ActivityHeatmapDay } from '../utils/activity-heatmap-data';
import {
  addCalendarDays,
  computeActivityStreaks,
  countActiveDaysInWindow,
  resolveHeatmapGrid,
  resolveHeatmapLayout,
} from '../utils/activity-heatmap-data';

const CELL = 13;
const GAP = 3;
const STEP = CELL + GAP;
const DAYS = 7;
const DAY_LABEL_W = 34;
const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LABELS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const GAMMA = 0.7;
const MONTH_ROW = 22;
const LEGEND_ROW = 34;
const HOUR_LABELS = [0, 6, 12, 18, 23];

const LIGHT_LEVELS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
const DARK_LEVELS  = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
const LIGHT_CELL_STROKE = 'rgba(27, 31, 36, 0.06)';
const DARK_CELL_STROKE = 'rgba(240, 246, 252, 0.04)';

function colorForValue(value: number, max: number, isDark: boolean): string {
  const levels = isDark ? DARK_LEVELS : LIGHT_LEVELS;
  if (value <= 0 || max <= 0) return levels[0];
  const ratio = Math.pow(value / max, GAMMA);
  const idx = Math.max(1, Math.min(4, Math.ceil(ratio * 4)));
  return levels[idx];
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function hourActivity(cell: HourlyHeatmapItem | undefined, metricLabel: 'tokens' | 'sessions'): number {
  if (!cell) return 0;
  if (metricLabel === 'sessions') return cell.eventCount;
  return cell.totalTokens > 0 ? cell.totalTokens : cell.eventCount;
}

function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    setWidth(Math.floor(ref.current.getBoundingClientRect().width));
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function ActivityHeatmap({
  days,
  today,
  startDate,
  range = '30d',
  hourly,
  nowHour,
  metricLabel = 'tokens',
  locale = 'en',
  className = '',
}: {
  days: ActivityHeatmapDay[];
  today?: string;
  startDate?: string;
  range?: string;
  hourly?: HourlyHeatmapItem[];
  nowHour?: number;
  metricLabel?: 'tokens' | 'sessions';
  locale?: Locale;
  className?: string;
}) {
  const isDark = useIsDark();
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolledRef = useRef(false);
  const containerWidth = useContainerWidth(containerRef);
  const monthLabels = locale === 'zh' ? MONTH_LABELS_ZH : MONTH_LABELS_EN;
  const layout = resolveHeatmapLayout(range);

  const [tooltip, setTooltip] = useState<{
    x: number; y: number;
    date: string; activityValue: number; cost: number;
  } | null>(null);

  const stats = useMemo(() => {
    const byDate = new Map<string, ActivityHeatmapDay>();
    for (const d of days) byDate.set(d.usageDate, d);

    const todayStr = today
      ?? days.map((day) => day.usageDate).sort().at(-1)
      ?? '1970-01-01';
    const rangeStart = startDate && startDate <= todayStr
      ? startDate
      : days.map((day) => day.usageDate).sort()[0] ?? todayStr;
    const { startStr, weeks } = resolveHeatmapGrid(todayStr, rangeStart);
    const visibleDays = days.filter((d) => d.usageDate >= rangeStart && d.usageDate <= todayStr);

    const maxActivity = Math.max(0, ...visibleDays.map(d => d.activityValue));
    const totalActivity = visibleDays.reduce((s, d) => s + d.activityValue, 0);
    const activeDays = countActiveDaysInWindow(days, rangeStart, todayStr);
    const windowDays = Math.max(1, weeks * DAYS);

    const { streak, longestStreak } = computeActivityStreaks(
      days,
      todayStr,
      windowDays,
    );

    const grid: Array<Array<{ dateStr: string; data?: ActivityHeatmapDay }>> = [];
    const monthMarks: Array<{ weekIdx: number; label: string }> = [];
    let lastMarkedMonth = -1;

    for (let w = 0; w < weeks; w++) {
      const col: Array<{ dateStr: string; data?: ActivityHeatmapDay }> = [];
      let monthToMark = -1;

      for (let d = 0; d < DAYS; d++) {
        const ds = addCalendarDays(startStr, w * DAYS + d);
        col.push({ dateStr: ds, data: byDate.get(ds) });
        if (ds >= rangeStart && ds <= todayStr && (ds.endsWith('-01') || (w === 0 && monthToMark === -1 && ds === rangeStart))) {
          monthToMark = Number(ds.slice(5, 7)) - 1;
        }
      }

      if (monthToMark !== -1 && monthToMark !== lastMarkedMonth) {
        monthMarks.push({ weekIdx: w, label: monthLabels[monthToMark] });
        lastMarkedMonth = monthToMark;
      }

      grid.push(col);
    }

    const hourRows: string[] = [];
    if (layout === 'day-hour') hourRows.push(todayStr);
    if (layout === 'week-hour') {
      for (let i = 0; i < 7; i++) hourRows.push(addCalendarDays(rangeStart, i));
    }
    const hourlyByKey = new Map<string, HourlyHeatmapItem>();
    for (const cell of hourly ?? []) hourlyByKey.set(`${cell.usageDate}|${cell.hour}`, cell);
    const hourValues = hourRows.flatMap((dateStr) =>
      Array.from({ length: 24 }, (_, hour) => hourActivity(hourlyByKey.get(`${dateStr}|${hour}`), metricLabel)),
    );
    const maxHourActivity = Math.max(0, ...hourValues);
    const totalHourActivity = hourValues.reduce((sum, value) => sum + value, 0);

    return {
      grid, monthMarks, maxActivity, activeDays, streak, longestStreak, totalActivity, weeks, rangeStart, todayStr,
      hourRows, hourlyByKey, maxHourActivity, totalHourActivity,
    };
  }, [days, today, startDate, monthLabels, layout, hourly, metricLabel]);

  const {
    grid, monthMarks, maxActivity, activeDays, streak, longestStreak, totalActivity, weeks, rangeStart, todayStr,
    hourRows, hourlyByKey, maxHourActivity, totalHourActivity,
  } = stats;

  const cell = CELL;
  const step = STEP;
  const svgInnerW = weeks * step - GAP;
  const svgW = DAY_LABEL_W + svgInnerW;
  const svgH = DAYS * step - GAP;
  const legendW = 22 + GAP + 5 * step - GAP + GAP + 26;
  const totalH = MONTH_ROW + svgH + LEGEND_ROW;
  const legendX = Math.max(DAY_LABEL_W, svgW - legendW);
  const tooltipMaxX = Math.max(0, (rootRef.current?.clientWidth ?? containerWidth) - 130);
  let lastMonthLabelX = -Infinity;
  const monthLabelMarks = monthMarks.map((mark) => {
    const x = Math.max(mark.weekIdx * step, lastMonthLabelX + 32);
    lastMonthLabelX = x;
    return { ...mark, x };
  });
  const dayUnit = locale === 'zh' ? '天' : 'd';
  const currentStreakLabel = locale === 'zh' ? '当前连续天数' : 'Current streak';
  const longestStreakLabel = locale === 'zh' ? '最长连续天数' : 'Longest streak';
  const activeDaysLabel = locale === 'zh' ? '活跃天数' : 'active days';
  const totalLabel = locale === 'zh'
    ? `${metricLabel === 'tokens' ? 'tokens' : 'sessions'} total`
    : `${metricLabel} total`;
  const hourNow = nowHour ?? 23;
  const hourLayout = layout === 'day-hour' || layout === 'week-hour';
  const displayTotal = hourLayout ? totalHourActivity : totalActivity;
  const displayMax = hourLayout ? maxHourActivity : maxActivity;

  useEffect(() => {
    hasAutoScrolledRef.current = false;
  }, [startDate, today, weeks, layout]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || hasAutoScrolledRef.current || containerWidth <= 0) return;
    if (el.scrollWidth > el.clientWidth) {
      el.scrollLeft = el.scrollWidth;
    }
    hasAutoScrolledRef.current = true;
  }, [containerWidth, svgW, startDate, today, weeks, layout]);

  const showHourTooltip = (
    dateStr: string,
    hour: number,
    activityValue: number,
    cost: number,
    x: number,
    y: number,
  ) => {
    const scrollLeft = containerRef.current?.scrollLeft ?? 0;
    const containerRect = containerRef.current?.getBoundingClientRect();
    const rootRect = rootRef.current?.getBoundingClientRect();
    const originX = containerRect && rootRect ? containerRect.left - rootRect.left : 0;
    const originY = containerRect && rootRect ? containerRect.top - rootRect.top : 0;
    setTooltip({
      x: originX + x - scrollLeft,
      y: originY + y,
      date: `${dateStr} ${String(hour).padStart(2, '0')}:00`,
      activityValue,
      cost,
    });
  };

  const renderHourGrid = () => {
    const dateLabelW = layout === 'week-hour' ? 44 : 0;
    const hourCell = CELL;
    const hourStep = STEP;
    const rowH = STEP;
    const gridW = dateLabelW + 24 * hourStep - GAP;
    const gridH = hourRows.length * rowH + (layout === 'day-hour' ? 18 : 8);
    const futureFill = isDark ? 'rgba(22,27,34,0.35)' : 'rgba(235,237,240,0.45)';

    return (
      <svg width={gridW} height={gridH + LEGEND_ROW} style={{ display: 'block' }} aria-label="Activity heatmap">
        {hourRows.map((dateStr, row) => (
          <g key={dateStr} transform={`translate(0, ${row * rowH})`}>
            {layout === 'week-hour' && (
              <text
                x={dateLabelW - 6}
                y={hourCell / 2}
                fontSize={10}
                fill={isDark ? '#8b949e' : '#57606a'}
                fontFamily="system-ui, sans-serif"
                textAnchor="end"
                dominantBaseline="middle"
              >
                {dateStr.slice(5)}
              </text>
            )}
            {Array.from({ length: 24 }, (_, hour) => {
              const cellData = hourlyByKey.get(`${dateStr}|${hour}`);
              const activityValue = hourActivity(cellData, metricLabel);
              const future = dateStr === todayStr && hour > hourNow;
              const fill = future
                ? futureFill
                : colorForValue(activityValue, displayMax, isDark);
              const x = dateLabelW + hour * hourStep;
              return (
                <rect
                  key={`${dateStr}-${hour}`}
                  x={x}
                  y={0}
                  width={hourCell}
                  height={hourCell}
                  rx={2}
                  fill={fill}
                  stroke={isDark ? DARK_CELL_STROKE : LIGHT_CELL_STROKE}
                  strokeWidth={1}
                  opacity={future ? 0.45 : 1}
                  style={{ cursor: activityValue > 0 ? 'pointer' : 'default' }}
                  onMouseEnter={() => showHourTooltip(dateStr, hour, activityValue, cellData?.estimatedCostUsd ?? 0, x + hourCell / 2, 0)}
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })}
          </g>
        ))}
        {HOUR_LABELS.map((hour) => (
          <text
            key={hour}
            x={dateLabelW + hour * hourStep + hourCell / 2}
            y={hourRows.length * rowH + 14}
            fontSize={10}
            fill={isDark ? '#8b949e' : '#57606a'}
            fontFamily="system-ui, sans-serif"
            textAnchor="middle"
          >
            {hour}
          </text>
        ))}
        <g transform={`translate(${Math.max(0, gridW - legendW)}, ${gridH + 4})`}>
          <text x={0} y={10} fontSize={10} fill={isDark ? '#8b949e' : '#57606a'} fontFamily="system-ui, sans-serif">Less</text>
          {[0, 1, 2, 3, 4].map((lvl) => {
            const levels = isDark ? DARK_LEVELS : LIGHT_LEVELS;
            return (
              <rect
                key={lvl}
                x={24 + lvl * step}
                y={0}
                width={cell}
                height={cell}
                rx={2}
                fill={levels[lvl]}
                stroke={isDark ? DARK_CELL_STROKE : LIGHT_CELL_STROKE}
                strokeWidth={1}
              />
            );
          })}
          <text x={24 + 5 * step} y={10} fontSize={10} fill={isDark ? '#8b949e' : '#57606a'} fontFamily="system-ui, sans-serif">More</text>
        </g>
      </svg>
    );
  };

  return (
    <div ref={rootRef} className={`relative grid gap-5 lg:grid-cols-[150px_minmax(0,1fr)] lg:items-center ${className}`}>
      <div className="grid grid-cols-2 gap-3 border-b border-slate-100 pb-4 dark:border-white/[0.08] lg:flex lg:flex-col lg:gap-5 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
        <div className="min-w-0 rounded-lg bg-slate-50/70 px-3 py-3 dark:bg-white/[0.04] lg:bg-transparent lg:p-0 lg:dark:bg-transparent">
          <div className="text-[28px] font-bold leading-none tracking-tight text-slate-900 dark:text-slate-100">
            {streak} <span className="text-base font-semibold text-slate-400 dark:text-slate-500">{dayUnit}</span>
          </div>
          <div className="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">{currentStreakLabel}</div>
        </div>
        <div className="min-w-0 rounded-lg bg-slate-50/70 px-3 py-3 dark:bg-white/[0.04] lg:bg-transparent lg:p-0 lg:dark:bg-transparent">
          <div className="text-[28px] font-bold leading-none tracking-tight text-slate-900 dark:text-slate-100">
            {longestStreak} <span className="text-base font-semibold text-slate-400 dark:text-slate-500">{dayUnit}</span>
          </div>
          <div className="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">{longestStreakLabel}</div>
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">{activeDays}</span> {activeDaysLabel}
          </span>
          <span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">{fmtCompact(displayTotal)}</span> {totalLabel}
          </span>
        </div>

        <div ref={containerRef} className="scrollbar-hide relative w-full overflow-x-auto pb-1">
          {containerWidth > 0 && (hourLayout ? renderHourGrid() : (
            <svg
              width={svgW}
              height={totalH}
              style={{ display: 'block' }}
              aria-label="Activity heatmap"
            >
              {[1, 3, 5].map((dayIdx) => (
                <text
                  key={dayIdx}
                  x={DAY_LABEL_W - 6}
                  y={MONTH_ROW + dayIdx * step + cell / 2}
                  fontSize={11}
                  fill={isDark ? '#8b949e' : '#57606a'}
                  fontFamily="system-ui, sans-serif"
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {dayIdx === 1 ? 'Mon' : dayIdx === 3 ? 'Wed' : 'Fri'}
                </text>
              ))}

              <g transform={`translate(${DAY_LABEL_W}, 0)`}>
                {monthLabelMarks.map(({ weekIdx, label, x }) => (
                  <text
                    key={label + weekIdx}
                    x={x}
                    y={MONTH_ROW - 4}
                    fontSize={10}
                    fill={isDark ? '#8b949e' : '#57606a'}
                    fontFamily="system-ui, sans-serif"
                  >
                    {label}
                  </text>
                ))}

                <g transform={`translate(0, ${MONTH_ROW})`}>
                  {grid.map((col, wi) =>
                    col.map(({ dateStr, data }, di) => {
                      const inRange = dateStr >= rangeStart && dateStr <= todayStr;
                      const activityValue = inRange ? (data?.activityValue ?? 0) : 0;
                      const cost = inRange ? (data?.estimatedCostUsd ?? 0) : 0;
                      const fill = inRange
                        ? colorForValue(activityValue, maxActivity, isDark)
                        : (isDark ? 'rgba(22,27,34,0.35)' : 'rgba(235,237,240,0.45)');
                      const x = wi * step;
                      const y = di * step;
                      return (
                        <rect
                          key={dateStr}
                          x={x}
                          y={y}
                          width={cell}
                          height={cell}
                          rx={2}
                          fill={fill}
                          stroke={isDark ? DARK_CELL_STROKE : LIGHT_CELL_STROKE}
                          strokeWidth={1}
                          opacity={inRange ? 1 : 0.55}
                          style={{ cursor: activityValue > 0 ? 'pointer' : 'default' }}
                          onMouseEnter={() => {
                            const scrollLeft = containerRef.current?.scrollLeft ?? 0;
                            const containerRect = containerRef.current?.getBoundingClientRect();
                            const rootRect = rootRef.current?.getBoundingClientRect();
                            const originX = containerRect && rootRect ? containerRect.left - rootRect.left : 0;
                            const originY = containerRect && rootRect ? containerRect.top - rootRect.top : 0;
                            setTooltip({
                              x: originX + DAY_LABEL_W + x + cell / 2 - scrollLeft,
                              y: originY + MONTH_ROW + y,
                              date: dateStr,
                              activityValue,
                              cost,
                            });
                          }}
                          onMouseLeave={() => setTooltip(null)}
                        />
                      );
                    })
                  )}
                </g>
              </g>

              <g transform={`translate(${legendX}, ${totalH - LEGEND_ROW + 10})`}>
                <text x={0} y={10} fontSize={10} fill={isDark ? '#8b949e' : '#57606a'} fontFamily="system-ui, sans-serif">Less</text>
                {[0, 1, 2, 3, 4].map((lvl) => {
                  const levels = isDark ? DARK_LEVELS : LIGHT_LEVELS;
                  return (
                    <rect
                      key={lvl}
                      x={24 + lvl * step}
                      y={0}
                      width={cell}
                      height={cell}
                      rx={2}
                      fill={levels[lvl]}
                      stroke={isDark ? DARK_CELL_STROKE : LIGHT_CELL_STROKE}
                      strokeWidth={1}
                    />
                  );
                })}
                <text x={24 + 5 * step} y={10} fontSize={10} fill={isDark ? '#8b949e' : '#57606a'} fontFamily="system-ui, sans-serif">More</text>
              </g>
            </svg>
          ))}
        </div>
      </div>

      {tooltip && (
        <div
          className="pointer-events-none absolute z-50 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-[#1a1a1a]"
          style={{
            left: Math.min(Math.max(tooltip.x, 0), tooltipMaxX),
            top: tooltip.y - 52,
          }}
        >
          <div className="font-medium text-slate-700 dark:text-slate-200">{tooltip.date}</div>
          {tooltip.activityValue > 0 ? (
            <>
              <div className="text-slate-500 dark:text-slate-400">{fmtCompact(tooltip.activityValue)} {metricLabel}</div>
              {metricLabel === 'tokens' && (
                <div className="text-slate-500 dark:text-slate-400">${tooltip.cost.toFixed(4)}</div>
              )}
            </>
          ) : (
            <div className="text-slate-400 dark:text-slate-500">No activity</div>
          )}
        </div>
      )}

      {days.length === 0 && (
        <p className="text-xs text-slate-400 dark:text-slate-500">No activity data in this range.</p>
      )}
    </div>
  );
}
