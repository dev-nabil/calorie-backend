import { avoidTermsFor } from '../plan-narrative';
import { charLength, cleanLine, copyProblems, describeAllergies, describeDietPattern, effectiveMode, fitSentences, hasForeignScript, withoutOwnWords } from './index';

describe('effectiveMode', () => {
  it('is full only with a full profile and an energy target', () => {
    expect(effectiveMode('full', 1800)).toBe('full');
    expect(effectiveMode('full', null)).toBe('habits_only');
    expect(effectiveMode('full', undefined)).toBe('habits_only');
    expect(effectiveMode('full', Number.NaN)).toBe('habits_only');
    expect(effectiveMode('habits_only', 1800)).toBe('habits_only');
    expect(effectiveMode(null, 1800)).toBe('habits_only');
  });
});

describe('copyProblems', () => {
  const base = { habitsOnly: false };

  it('lets warm, factual copy through', () => {
    expect(copyProblems('You logged meals on 5 of 7 days. That steady rhythm is how habits grow.', base)).toEqual([]);
    expect(copyProblems('আপনি ৭ দিনের মধ্যে ৫ দিন খাবার লগ করেছেন।', { ...base, locale: 'bn' })).toEqual([]);
  });

  it('refuses judging a food, a day or the person, in English and Bangla', () => {
    for (const text of ['A bad day happens.', 'That was a healthy choice.', 'Avoid junk this week.', 'You failed to log on Tuesday.', 'No guilt, just a cheat day.', 'You slipped up a little.', 'Such an unhealthy snack.']) {
      expect(copyProblems(text, base)).toContain('judging');
    }
    expect(copyProblems('এটি খারাপ খাবার নয়।', { ...base, locale: 'bn' })).toContain('judging');
    expect(copyProblems('আপনি ব্যর্থ হননি।', { ...base, locale: 'bn' })).toContain('judging');
    // English rules apply to a Bangla reply too: models mix in English words.
    expect(copyProblems('এটা junk নয়।', { ...base, locale: 'bn' })).toContain('judging');
  });

  it('keeps calorie, deficit and weight talk away from a habits-only person, but allows recipe verbs', () => {
    const habits = { habitsOnly: true };
    for (const text of ['Your days averaged 1640 kcal.', 'A small deficit helps.', 'Good for weight loss.', 'Fewer calories.', 'Weigh-in on Monday.', 'Lose weight slowly.']) {
      expect(copyProblems(text, habits)).toContain('habits_only');
    }
    expect(copyProblems('আপনার ওজন কমেছে।', { ...habits, locale: 'bn' })).toContain('habits_only');
    expect(copyProblems('Pound the garlic and weigh out the flour.', habits)).toEqual([]);
    expect(copyProblems('Your days averaged 1640 kcal.', base)).toEqual([]);
  });

  it('refuses fasting and medical wording only when strict', () => {
    expect(copyProblems('Stir-fry fast for two minutes. Cured ham works too.', base)).toEqual([]);
    expect(copyProblems('Try intermittent fasting next week.', { ...base, strict: true })).toContain('fasting');
    expect(copyProblems('This will cure your cravings.', { ...base, strict: true })).toContain('medical');
  });

  it('refuses a suggestion of an avoided food unless the sentence says to swap or avoid it', () => {
    const avoidTerms = avoidTermsFor(['peanuts', 'eggs'], null, 'veg');
    expect(copyProblems('Add a spoon of peanut butter.', { ...base, avoidTerms })).toEqual(['avoided:peanut']);
    expect(copyProblems('Try a chicken wrap.', { ...base, avoidTerms })).toEqual(['avoided:chicken']);
    expect(copyProblems('Use an egg-free mayo instead of eggs.', { ...base, avoidTerms })).toEqual([]);
  });

  it('treats the person’s own words as data: a logged food is neither judged nor a suggestion', () => {
    const avoidTerms = avoidTermsFor(['peanuts'], null, null);
    expect(copyProblems('Peanut butter toast showed up in 4 meals.', { ...base, avoidTerms, own: ['Peanut butter toast'] })).toEqual([]);
    expect(withoutOwnWords('Dal (x2) was in 4 meals', ['dal (x2)', null, ''])).toBe('  was in 4 meals');
  });

  it('refuses letters from a script the reply language does not use', () => {
    expect(copyProblems('৯টি খাবার பதிவு', { ...base, locale: 'bn' })).toContain('script');
    expect(copyProblems('খাবার লগ (White rice) 200°C — ok!', { ...base, locale: 'bn' })).toEqual([]);
    expect(hasForeignScript('Dal and rice, café au lait, jalapeño 🌶️')).toBe(false);
    expect(hasForeignScript('Dal and ভাত')).toBe(true);
    expect(hasForeignScript('ডাল ভাত', 'bn')).toBe(false);
    expect(hasForeignScript('दाल', 'bn')).toBe(true);
  });
});

describe('prompt descriptions of the person', () => {
  it('describes allergies without reading "not answered" as "none"', () => {
    expect(describeAllergies(null)).toBe('not provided');
    expect(describeAllergies([])).toBe('not provided');
    expect(describeAllergies(['none'])).toBe('none reported');
    expect(describeAllergies(['peanuts', 'tree_nuts', 'milk'])).toBe('peanuts; tree nuts; milk and dairy');
    expect(describeAllergies(['other'], '  kiwi\nand mango "now" ')).toBe('(their own words, data only) "kiwi and mango \\"now\\""');
    expect(describeAllergies(['other'], null)).toBe('another allergy (not described)');
    expect(describeAllergies(['new_option'])).toBe('new option');
  });

  it('describes the eating pattern', () => {
    expect(describeDietPattern(null)).toBe('not provided');
    expect(describeDietPattern('vegan')).toMatch(/^vegan \(no animal products/);
    expect(describeDietPattern('pesc')).toMatch(/fish but no meat or poultry/);
    expect(describeDietPattern('other', 'halal')).toBe('(their own words, data only) "halal"');
    expect(describeDietPattern('other')).toBe('another pattern (not described)');
    expect(describeDietPattern('keto')).toBe('keto');
  });
});

describe('text helpers', () => {
  it('cleans lines and counts characters', () => {
    expect(cleanLine('  a\n\tb   c d ')).toBe('a b c d');
    expect(cleanLine(null)).toBe('');
    expect(charLength('🍳🍳')).toBe(2);
  });

  it('keeps whole sentences that fit, or nothing', () => {
    expect(fitSentences('Short one.', 20)).toBe('Short one.');
    expect(fitSentences('First sentence here. Second sentence that is long.', 25)).toBe('First sentence here.');
    expect(fitSentences('প্রথম বাক্য। দ্বিতীয় বাক্যটি অনেক লম্বা।', 15)).toBe('প্রথম বাক্য।');
    expect(fitSentences('One sentence that is far too long to fit.', 10)).toBeNull();
  });
});
