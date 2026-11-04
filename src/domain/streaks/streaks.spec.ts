import { computeStreak } from './index';

describe('computeStreak (BR-08)', () => {
  const today = '2026-11-05'; // Thursday

  it('is zero with no logged days', () => {
    const s = computeStreak([], today);
    expect(s).toMatchObject({ current: 0, longest: 0, loggedToday: false, loggedThisWeek: 0 });
    expect(s.week.map((w) => w.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('counts consecutive days ending today', () => {
    const s = computeStreak(['2026-11-03', '2026-11-04', '2026-11-05'], today);
    expect(s.current).toBe(3);
    expect(s.loggedToday).toBe(true);
    expect(s.loggedThisWeek).toBe(3);
  });

  it('keeps the streak alive through yesterday while today is not logged yet', () => {
    const s = computeStreak(['2026-11-03', '2026-11-04'], today);
    expect(s.current).toBe(2);
    expect(s.loggedToday).toBe(false);
  });

  it('resets after a missed day but keeps the longest run', () => {
    const s = computeStreak(
      ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-11-04', '2026-11-05', '2026-11-05'],
      today,
    );
    expect(s.current).toBe(2);
    expect(s.longest).toBe(4);
  });

  it('is zero when yesterday and today are both missed', () => {
    expect(computeStreak(['2026-11-01', '2026-11-02', '2026-11-03'], today).current).toBe(0);
    expect(computeStreak(['2026-11-01', '2026-11-02', '2026-11-03'], today).longest).toBe(3);
  });

  it('ignores future days and invalid keys', () => {
    const s = computeStreak(['2026-11-05', '2026-11-06', 'nope', '2026-02-30'], today);
    expect(s.current).toBe(1);
    expect(s.longest).toBe(1);
    expect(s.week.find((w) => w.date === '2026-11-06')?.logged).toBe(false);
  });

  it('runs across month and year boundaries', () => {
    expect(computeStreak(['2026-12-30', '2026-12-31', '2027-01-01'], '2027-01-01').current).toBe(3);
  });
});
