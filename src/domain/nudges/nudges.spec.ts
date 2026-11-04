import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chooseNudge, inWindow, localMinutes, parseWindow, type NudgeContent, type NudgeFacts } from './index';

const content = (JSON.parse(readFileSync(resolve(__dirname, '../../../content/milo/lines.v1.json'), 'utf8')) as { nudges: NudgeContent }).nudges;
const none = { breakfast: false, lunch: false, dinner: false, snack: false };
const facts = (over: Partial<NudgeFacts> = {}): NudgeFacts => ({
  localMinutes: 8 * 60,
  logged: { ...none },
  mode: 'full',
  overTarget: false,
  pendingScan: false,
  savedPhoto: false,
  ...over,
});

describe('nudges (Today card)', () => {
  it('parses and wraps windows', () => {
    expect(parseWindow('05:00–10:59')).toEqual({ start: 300, end: 659 });
    expect(parseWindow('nope')).toBeNull();
    expect(inWindow(23 * 60, '22:00–04:59')).toBe(true);
    expect(inWindow(3 * 60, '22:00-04:59')).toBe(true);
    expect(inWindow(12 * 60, '22:00–04:59')).toBe(false);
    expect(inWindow(1, 'bad')).toBe(false);
  });
  it('follows priority: pending scan, saved photo, over target', () => {
    expect(chooseNudge(content, facts({ pendingScan: true, savedPhoto: true }))?.id).toBe('nudge.pendingScan');
    expect(chooseNudge(content, facts({ savedPhoto: true }))?.id).toBe('nudge.savedPhoto');
    expect(chooseNudge(content, facts({ overTarget: true }))?.id).toBe('nudge.overTarget');
    expect(chooseNudge(content, facts({ overTarget: true, mode: 'habits_only' }))?.id).not.toBe('nudge.overTarget');
  });
  it('suggests the meal for the time window and category', () => {
    expect(chooseNudge(content, facts())).toEqual({ id: 'nudge.breakfast', category: 'breakfast' });
    expect(chooseNudge(content, facts({ logged: { ...none, breakfast: true } }))?.id).toBe('nudge.breakfastLogged');
    expect(chooseNudge(content, facts({ localMinutes: 12 * 60 }))).toEqual({ id: 'nudge.lunch', category: 'lunch' });
    expect(chooseNudge(content, facts({ localMinutes: 19 * 60 }))?.category).toBe('dinner');
    expect(chooseNudge(content, facts({ localMinutes: 23 * 60 }))?.id).toBe('nudge.late');
  });
  it('falls back and handles empty content', () => {
    expect(chooseNudge({ timeWindows: {}, items: [{ id: 'x', priority: 1, when: { logged: { any: true } } }] }, facts())).toBeNull();
    expect(chooseNudge({ timeWindows: {}, items: [{ id: 'y', priority: 1, when: { logged: { any: false } } }] }, facts())?.id).toBe('y');
  });
  it('computes local minutes in a zone', () => {
    expect(localMinutes(new Date('2026-11-02T14:50:00Z'), 'Asia/Tokyo')).toBe(23 * 60 + 50);
    expect(localMinutes(new Date('2026-11-02T00:10:00Z'), 'Europe/London')).toBe(10);
  });
});
