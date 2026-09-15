import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  computeActivityStreaks,
  datesFromMonthStartThrough,
  isDayActive,
} from '../activity';

describe('activity calendar', () => {
  it('adds calendar days on YYYY-MM-DD without using a local Date', () => {
    expect(addCalendarDays('2026-09-15', -1)).toBe('2026-09-14');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('treats a 0-token day with events as active', () => {
    expect(isDayActive({ activityValue: 0, eventCount: 1, totalTokens: 0 })).toBe(true);
    expect(isDayActive({ activityValue: 0, eventCount: 0, totalTokens: 0 })).toBe(false);
  });

  it('keeps the current streak alive when today has no activity yet', () => {
    expect(computeActivityStreaks([
      { usageDate: '2026-09-13', activityValue: 10 },
      { usageDate: '2026-09-14', activityValue: 20 },
    ], '2026-09-15')).toEqual({ streak: 2, longestStreak: 2 });
  });

  it('starts the current streak from today when today already has activity', () => {
    expect(computeActivityStreaks([
      { usageDate: '2026-09-13', eventCount: 10 },
      { usageDate: '2026-09-14', eventCount: 20 },
      { usageDate: '2026-09-15', eventCount: 5 },
    ], '2026-09-15')).toEqual({ streak: 3, longestStreak: 3 });
  });

  it('resets the current streak after a missed full day', () => {
    expect(computeActivityStreaks([
      { usageDate: '2026-09-12', activityValue: 10 },
      { usageDate: '2026-09-13', activityValue: 10 },
    ], '2026-09-15')).toEqual({ streak: 0, longestStreak: 2 });
  });

  it('does not break a streak on an event-only day with 0 tokens', () => {
    expect(computeActivityStreaks([
      { usageDate: '2026-09-13', totalTokens: 100 },
      { usageDate: '2026-09-14', totalTokens: 0, eventCount: 1 },
      { usageDate: '2026-09-15', totalTokens: 50 },
    ], '2026-09-15')).toEqual({ streak: 3, longestStreak: 3 });
  });

  it('matches the live Aug 31–Sep 15 run and the Jun 1–Jul 29 longest run', () => {
    const days = [
      ...range('2026-06-01', '2026-07-29'),
      ...range('2026-08-31', '2026-09-15'),
    ].map((usageDate) => ({ usageDate, eventCount: 1 }));

    expect(computeActivityStreaks(days, '2026-09-15')).toEqual({
      streak: 16,
      longestStreak: 59,
    });
  });

  it('pads a month only through today, not future days', () => {
    expect(datesFromMonthStartThrough('2026-09-15')).toEqual(
      range('2026-09-01', '2026-09-15'),
    );
  });
});

function range(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}
