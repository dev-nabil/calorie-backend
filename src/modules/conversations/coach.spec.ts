import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DayResponse } from '../../shared';
import { fillSingle } from '../content/content.loader';
import { keepNumbers, quickActionFromContent, quickActionTemplate, whenHolds, type QuickAction, type QuickFacts } from './coach.service';

const lines = JSON.parse(readFileSync(resolve(__dirname, '../../../content/milo/lines.v1.json'), 'utf8'));
const coach = lines.coach;

const day = (over: Partial<DayResponse> = {}): DayResponse =>
  ({
    date: '2026-11-02',
    targets: { energyKcal: 2100, proteinG: 125, carbsG: 240, fatG: 63, waterMl: 2500 },
    totals: { kcal: 716, proteinG: 40, carbsG: 80, fatG: 26 },
    meals: [{ category: 'breakfast' }, { category: 'snack' }, { category: 'lunch' }],
    water: { totalMl: 1000, targetMl: 2500, stepMl: 250, entries: [] },
    ...over,
  }) as unknown as DayResponse;
const facts = (over: Partial<QuickFacts> = {}): QuickFacts => ({ day: day(), habitsOnly: false, vegan: false, noPhoto: false, openSlot: null, ...over });

describe('coach quick actions from content (coach.quickActions)', () => {
  it('fills single-brace placeholders and leaves unknown ones', () => {
    expect(fillSingle('Hi {name}, {x}', { name: 'Alex' })).toBe('Hi Alex, {x}');
  });

  it('every placeholder in every variant gets filled for matching facts', () => {
    const scenarios: QuickFacts[] = [
      facts(),
      facts({ habitsOnly: true }),
      facts({ day: day({ meals: [] }) }),
      facts({ day: day({ meals: [] }), noPhoto: true }),
      facts({ day: day({ totals: { kcal: 2500, proteinG: 1, carbsG: 1, fatG: 1 } }) }),
      facts({ vegan: true }),
      facts({ vegan: true, habitsOnly: true }),
      facts({ openSlot: 'Dinner' }),
    ];
    const seen = new Set<string>();
    for (const action of Object.keys(coach.quickActions) as QuickAction[]) {
      for (const f of scenarios) {
        const r = quickActionFromContent(coach, action, f);
        expect(r).not.toBeNull();
        expect(r!.text).not.toMatch(/\{\w+\}/);
        seen.add(r!.id);
      }
    }
    // The selection reaches every variant the product wrote.
    for (const action of Object.keys(coach.quickActions) as QuickAction[]) {
      for (const v of coach.quickActions[action].variants) expect(seen).toContain(v.id);
    }
  });

  it('picks the first matching variant in list order', () => {
    expect(quickActionFromContent(coach, 'explain_macros', facts({ habitsOnly: true }))!.id).toBe('coach.qa.explain_macros.habitsOnly');
    expect(quickActionFromContent(coach, 'explain_macros', facts())!.text).toContain('2,100 kcal');
    expect(quickActionFromContent(coach, 'review_day', facts({ day: day({ meals: [] }), noPhoto: true }))!.id).toBe('coach.qa.review_day.emptyNoPhoto');
    expect(quickActionFromContent(coach, 'review_day', facts({ day: day({ meals: [{}] as never }) }))!.text).toContain('1 meal and');
    expect(quickActionFromContent(coach, 'review_day', facts({ openSlot: 'Dinner' }))!.text).toContain('Dinner is still open');
    expect(quickActionFromContent(coach, 'suggest_snack', facts({ day: day({ totals: { kcal: 1950, proteinG: 0, carbsG: 0, fatG: 0 } }) }))!.id).toBe('coach.qa.suggest_snack.fullClose');
    expect(whenHolds('something new', facts())).toBe(false);
  });

  it('habits-only answers never contain calorie numbers', () => {
    for (const action of Object.keys(coach.quickActions) as QuickAction[]) {
      expect(quickActionFromContent(coach, action, facts({ habitsOnly: true }))!.text).not.toMatch(/kcal|\d+ g /);
    }
  });

  it('keeps the template unless a rephrase keeps every number', () => {
    const t = 'You have 1,384 kcal left of 2,100 kcal.';
    expect(keepNumbers(t, 'Nice! 1,384 kcal remain from your 2,100 kcal.')).toBe('Nice! 1,384 kcal remain from your 2,100 kcal.');
    expect(keepNumbers(t, 'Try a yoghurt.')).toBe(t);
    expect(keepNumbers(t, '  ')).toBe(t);
  });

  it('falls back to backend wording when content is missing', () => {
    expect(quickActionFromContent(undefined, 'review_day', facts())).toBeNull();
    expect(quickActionTemplate('explain_macros', day(), false)).toContain('2,100 kcal');
    expect(quickActionTemplate('explain_macros', day(), true)).not.toMatch(/kcal/);
    expect(quickActionTemplate('review_day', day({ meals: [] }), false)).toContain('Nothing logged');
    expect(quickActionTemplate('review_day', day({ totals: { kcal: 2500, proteinG: 0, carbsG: 0, fatG: 0 } }), false)).toContain('a little over');
    expect(quickActionTemplate('suggest_snack', day(), false)).toContain('snack');
  });
});
