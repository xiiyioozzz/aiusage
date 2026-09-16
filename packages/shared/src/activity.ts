/** Calendar-day helpers that stay on YYYY-MM-DD strings. Never use the viewer's local Date. */

export function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addCalendarDays(dateStr: string, days: number): string {
  const date = parseDateOnly(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

export function weekdayUtc(dateStr: string): number {
  return parseDateOnly(dateStr).getUTCDay();
}

export function diffCalendarDays(start: string, end: string): number {
  return Math.round((parseDateOnly(end).getTime() - parseDateOnly(start).getTime()) / 86_400_000);
}

export function shiftCalendarYear(dateStr: string, years: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const nextYear = (year ?? 1970) + years;
  const lastDay = new Date(Date.UTC(nextYear, month ?? 1, 0)).getUTCDate();
  return `${String(nextYear).padStart(4, '0')}-${String(month ?? 1).padStart(2, '0')}-${String(Math.min(day ?? 1, lastDay)).padStart(2, '0')}`;
}

export function datesFromMonthStartThrough(today: string): string[] {
  const day = Number(today.slice(8, 10));
  const prefix = today.slice(0, 8);
  const dates: string[] = [];
  for (let d = 1; d <= day; d += 1) {
    dates.push(`${prefix}${String(d).padStart(2, '0')}`);
  }
  return dates;
}

export function isDayActive(day: {
  activityValue?: number;
  eventCount?: number;
  totalTokens?: number;
} | undefined): boolean {
  if (!day) return false;
  return (day.activityValue ?? 0) > 0
    || (day.eventCount ?? 0) > 0
    || (day.totalTokens ?? 0) > 0;
}

/**
 * Current streak walks backward from `today`. An empty today still counts as
 * in-progress, so the run continues from yesterday until that calendar day ends.
 * A fully missed yesterday resets the current streak to 0.
 * Longest streak only looks at calendar days through today.
 */
export function computeActivityStreaks(
  days: Array<{ usageDate: string; activityValue?: number; eventCount?: number; totalTokens?: number }>,
  today: string,
  windowDays = 371,
): { streak: number; longestStreak: number } {
  const byDate = new Map(days.map((day) => [day.usageDate, day]));
  const activeOn = (dateStr: string) => isDayActive(byDate.get(dateStr));

  const startOffset = activeOn(today) ? 0 : 1;
  let streak = 0;
  for (let i = startOffset; i < windowDays; i += 1) {
    if (!activeOn(addCalendarDays(today, -i))) break;
    streak += 1;
  }

  let longestStreak = 0;
  let run = 0;
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const dateStr = addCalendarDays(today, -i);
    if (dateStr > today) continue;
    if (activeOn(dateStr)) {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else {
      run = 0;
    }
  }

  return { streak, longestStreak };
}
