import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planNarrativeJsonSchema, PLAN_NARRATIVE_EXAMPLE } from '../../modules/ai/ai.provider';
import { PlanNarrativeSchema, type PlanNarrative } from '../../shared';
import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import { loadQuestionSet, type ProfileFields } from '../onboarding-engine';
import { assessPlan } from '../plan-assessment';
import { calculatePlan } from '../plan-calculator';
import { avoidTermsFor, buildNarrativeContext, checkNarrative, makeLabeler, planInputHash } from './index';

const good = (): PlanNarrative => structuredClone(PLAN_NARRATIVE_EXAMPLE) as PlanNarrative;
const profile = (over: Partial<ProfileFields> = {}): ProfileFields => ({
  primaryGoal: 'lose', supportingGoals: [], personalMotivation: null, requestedFeatures: [], displayName: 'Alex Private', ageYears: 34,
  birthDate: '1991-02-03', calculationSex: 'female', heightCm: 168, weightKg: 82, weightIsEstimate: false, targetWeightKg: 74,
  activityLevel: 'light', dietPattern: 'veg', mealSource: 'home', nutritionFamiliarity: 'some', startingMood: 'ready',
  habitPriorities: [], loggingMethods: [], timeframeWeeks: 26, allergies: ['peanuts'], allergyOther: null, dietPatternOther: null,
  mealsPerDay: 'three', schedulePattern: 'shifts', higherIntakePattern: null, trackingExperience: null, routineBarriers: ['busy'], eatingCues: [],
  ...over,
});

describe('checkNarrative', () => {
  it('accepts a clean narrative', () => {
    expect(PlanNarrativeSchema.safeParse(good()).success).toBe(true);
    expect(checkNarrative(good(), [])).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ['1,800 kcal a day'],
    ['about 30 g of protein'],
    ['lose 2 kg'],
    ['10% less'],
    ['in 12 weeks'],
    ['2 litres of water'],
    ['1500 calories'],
    ['200ml of milk'],
  ])('rejects the figure in "%s"', (text) => {
    const n = good();
    n.guidance[0]!.body = `Aim for ${text} and keep it steady.`;
    const c = checkNarrative(n, []);
    expect(c.ok).toBe(false);
    expect(c.problems.join()).toMatch(/figure/);
  });

  it('allows counts of things that are not measurements', () => {
    const n = good();
    n.guidance[0]!.body = 'Keep three meals and one snack at roughly the same times each day.';
    expect(checkNarrative(n, []).ok).toBe(true);
  });

  it('rejects fasting, skipped meals, moral wording and medical claims', () => {
    for (const bad of ['Try an intermittent fasting window.', 'Skip breakfast on busy days.', 'Avoid junk food at all costs.', 'This will cure your cravings.', 'A quick detox helps.']) {
      const n = good();
      n.summary = `Your plan is built around regular meals. ${bad}`;
      expect(checkNarrative(n, []).ok).toBe(false);
    }
  });

  it('rejects a suggestion containing the user\'s allergen unless it says to avoid or swap it', () => {
    const terms = avoidTermsFor(['peanuts', 'gluten'], null);
    const n = good();
    n.guidance[0]!.body = 'A slice of toast with peanut butter makes an easy breakfast on busy days.';
    expect(checkNarrative(n, terms).ok).toBe(false);
    n.guidance[0]!.body = 'Swap anything with peanuts in it for seeds, and check the label every time you shop.';
    expect(checkNarrative(n, terms).ok).toBe(true);
    n.guidance[0]!.body = 'Wholegrain bread with a simple filling keeps lunch quick on busy days.';
    expect(checkNarrative(n, terms).ok).toBe(false);
  });

  it('treats free-text allergens as terms too', () => {
    expect(avoidTermsFor(['other'], 'Kiwi, mango')).toEqual(expect.arrayContaining(['kiwi', 'mango']));
    const n = good();
    n.guidance[1]!.body = 'Keep a bowl of kiwi fruit on the counter for a quick snack between meetings.';
    expect(checkNarrative(n, avoidTermsFor(['other'], 'kiwi')).ok).toBe(false);
  });

  it('rejects repeated guidance titles', () => {
    const n = good();
    n.guidance[1]!.title = n.guidance[0]!.title;
    expect(checkNarrative(n, []).problems).toContain('repeats a guidance title');
  });

  it('enforces the length and count limits of the schema', () => {
    const n = good();
    n.headline = 'x'.repeat(91);
    expect(PlanNarrativeSchema.safeParse(n).success).toBe(false);
    const m = good();
    m.guidance = m.guidance.slice(0, 2);
    expect(PlanNarrativeSchema.safeParse(m).success).toBe(false);
  });
});

describe('checkNarrative: review findings', () => {
  const withBody = (body: string) => {
    const n = good();
    n.guidance[0]!.body = body;
    return n;
  };

  it.each([
    ['fish', 'Grilled anchovies on toast are a quick lunch to prepare.'],
    ['shellfish', 'Squid with lemon makes a light supper on busy evenings.'],
    ['milk', 'A spoonful of ghee on your vegetables adds flavour at dinner.'],
    ['tree_nuts', 'A little pesto stirred through your meal adds flavour on busy nights.'],
    ['gluten', 'A bowl of oats with fruit is an easy start to a busy morning.'],
    ['eggs', 'Make a quick frittata with leftover vegetables for lunch on busy days.'],
    ['soy', 'Tofu cooks quickly and fits into most weeknight meals very easily.'],
    ['sesame', 'A spoonful of tahini in a dressing makes salads feel more filling.'],
    ['peanuts', 'A peanut satay sauce makes a plain meal feel more interesting.'],
  ])('every %s allergen word is caught', (id, text) => {
    expect(checkNarrative(withBody(text), avoidTermsFor([id], null)).ok).toBe(false);
  });

  it('short free-text allergens count too ("nut", "egg", "soy", "fig")', () => {
    for (const word of ['nut', 'egg', 'soy', 'fig']) {
      const terms = avoidTermsFor(['other'], word);
      expect(terms).toContain(word);
      expect(checkNarrative(withBody(`A little ${word} on the side makes lunch feel complete on busy days.`), terms).ok).toBe(false);
    }
    expect(checkNarrative(withBody('A handful of nuts makes a quick snack between meetings.'), avoidTermsFor(['other'], 'nut')).ok).toBe(false);
  });

  it('naming the allergen is fine only when the sentence says to leave it out', () => {
    const terms = avoidTermsFor(['milk'], null);
    expect(checkNarrative(withBody('Check the label, then add a glass of milk to your breakfast.'), terms).ok).toBe(false);
    expect(checkNarrative(withBody('It is not hard to add milk to a smoothie when you are in a hurry.'), terms).ok).toBe(false);
    expect(checkNarrative(withBody('Swap milk for an oat drink in your smoothie so breakfast stays quick.'), terms).ok).toBe(true);
    expect(checkNarrative(withBody('Choose a dairy-free yoghurt with fruit for a quick breakfast on busy days.'), terms).ok).toBe(true);
  });

  it('follows the eating pattern', () => {
    expect(checkNarrative(withBody('Grilled chicken with salad is a quick lunch on busy days at work.'), avoidTermsFor(null, null, 'veg')).ok).toBe(false);
    expect(checkNarrative(withBody('Grilled chicken with salad is a quick lunch on busy days at work.'), avoidTermsFor(null, null, 'pesc')).ok).toBe(false);
    expect(checkNarrative(withBody('Grilled salmon with salad is a quick lunch on busy days at work.'), avoidTermsFor(null, null, 'pesc')).ok).toBe(true);
    expect(checkNarrative(withBody('Scrambled eggs on toast make a quick breakfast on most mornings.'), avoidTermsFor(null, null, 'vegan')).ok).toBe(false);
    expect(checkNarrative(withBody('Beans on toast make a quick breakfast on most mornings of the week.'), avoidTermsFor(null, null, 'vegan')).ok).toBe(true);
  });

  it.each([['Aim for 1800 a day and keep it steady.'], ['Around 1,800 daily works for most people.'], ['Try about 2k calories.'], ['Roughly fourteen hundred calories is plenty.'], ['Keep it near twenty percent lower.']])('catches the disguised figure in "%s"', (text) => {
    const c = checkNarrative(withBody(text), []);
    expect(c.ok).toBe(false);
  });

  it.each([['Cut out all carbs in the evening.'], ['Weigh yourself every morning to stay on track.'], ['A laxative tea helps you reset.'], ['Never eat bread again.']])('rejects restriction and purging advice: "%s"', (text) => {
    expect(checkNarrative(withBody(text), []).ok).toBe(false);
  });
});

describe('checkNarrative: Bangla', () => {
  const bn = (body: string) => {
    const n = good();
    n.guidance[0]!.body = body;
    return n;
  };
  const terms = (allergies: string[], diet?: string) => avoidTermsFor(allergies, null, diet, 'bn');

  it('stating the allergy is fine in Bangla too', () => {
    const n = good();
    n.watchOuts = ['আপনি বললেন চিনাবাদামে অ্যালার্জি আছে, তাই প্রতিটি প্যাকেটের লেবেল দেখে নিন।'];
    expect(checkNarrative(n, terms(['peanuts']), 'bn').ok).toBe(true);
  });

  it('accepts a clean Bangla narrative', () => {
    expect(checkNarrative(bn('সকালে একটি নির্দিষ্ট সময়ে খাবার খেলে ক্ষুধা বোঝা সহজ হয় এবং সিদ্ধান্ত নেওয়া সরল হয়।'), terms([]), 'bn').ok).toBe(true);
  });

  it.each([
    ['১৮০০ ক্যালরি খান'],
    ['প্রতিদিন 1800 ক্যালরি'],
    ['সপ্তাহে ২ কেজি কমান'],
    ['১২ সপ্তাহে লক্ষ্যে পৌঁছান'],
    ['প্রোটিন ৩০ গ্রাম নিন'],
    ['প্রায় ১০% কম খান'],
    ['দুই হাজার ক্যালরি যথেষ্ট'],
    ['দেড় হাজার ক্যালরি ঠিক আছে'],
  ])('catches the figure in "%s", including Bengali numerals', (text) => {
    expect(checkNarrative(bn(text), [], 'bn').ok).toBe(false);
  });

  it('allows small counts written in words', () => {
    expect(checkNarrative(bn('দিনে তিনবার খাবার খেলে রুটিন ঠিক থাকে, সঙ্গে একটি নাশতা রাখুন।'), [], 'bn').ok).toBe(true);
  });

  it.each([
    ['milk', 'সকালে এক গ্লাস দুধের সঙ্গে ফল খেতে পারেন।'],
    ['milk', 'নাশতায় দই ও কলা রাখলে পেট ভরা থাকে।'],
    ['eggs', 'সকালে সেদ্ধ ডিম খেলে পেট ভরা লাগে।'],
    ['fish', 'দুপুরে ইলিশ মাছ দিয়ে ভাত খেতে পারেন।'],
    ['shellfish', 'রাতে চিংড়ি ভুনা দিয়ে হালকা খাবার খান।'],
    ['peanuts', 'বিকেলে এক মুঠো চিনাবাদাম খেতে পারেন।'],
    ['tree_nuts', 'নাশতায় কাজুবাদাম রাখলে ভালো লাগবে।'],
    ['gluten', 'সকালে রুটি ও সবজি খেলে সুবিধা হয়।'],
    ['soy', 'দুপুরে সয়াবিনের তরকারি রাখতে পারেন।'],
    ['sesame', 'সালাদে তিলের তেল ব্যবহার করতে পারেন।'],
  ])('%s: catches "%s"', (id, text) => {
    expect(checkNarrative(bn(text), terms([id]), 'bn').ok).toBe(false);
  });

  it('stating the allergy is fine, suggesting the food is not (English)', () => {
    const t = avoidTermsFor(['peanuts'], null);
    const body = (text: string) => {
      const n = good();
      n.watchOuts = [text];
      return n;
    };
    expect(checkNarrative(body('You told us you have a peanut allergy, so check every label.'), t).ok).toBe(true);
    expect(checkNarrative(body('Peanut butter on toast is a quick breakfast for busy days.'), t).ok).toBe(false);
  });

  it('naming the food is fine only when the sentence says to leave it out', () => {
    const t = terms(['milk']);
    expect(checkNarrative(bn('দুধ এড়িয়ে চলুন এবং বিকল্প হিসেবে নারকেলের দুধ বা সয়া পানীয় বেছে নিন।'), t, 'bn').ok).toBe(true);
    expect(checkNarrative(bn('লেবেল দেখে নিন, তারপর এক গ্লাস দুধ যোগ করুন।'), t, 'bn').ok).toBe(false);
  });

  it('knows the eating pattern in Bangla and in English words', () => {
    expect(checkNarrative(bn('দুপুরে মুরগির মাংস দিয়ে ভাত খেতে পারেন।'), terms([], 'veg'), 'bn').ok).toBe(false);
    expect(checkNarrative(bn('দুপুরে ডাল ও সবজি দিয়ে ভাত খেতে পারেন।'), terms([], 'veg'), 'bn').ok).toBe(true);
    expect(checkNarrative(bn('এক টুকরো মধু দিয়ে চা খেতে পারেন।'), terms([], 'vegan'), 'bn').ok).toBe(false);
    expect(checkNarrative(bn('Grilled chicken makes a quick lunch for busy days at work.'), terms([], 'veg'), 'bn').ok).toBe(false);
  });

  it('rejects restriction, purging, fasting and medical claims in Bangla', () => {
    for (const text of ['ভাত পুরোপুরি বাদ দিন।', 'প্রতিদিন সকালে ওজন মাপুন।', 'ডিটক্স করলে শরীর পরিষ্কার হয়।', 'ইন্টারমিটেন্ট ফাস্টিং শুরু করুন।', 'ব্যস্ত দিনে দুপুরের খাবার বাদ দিন।', 'এই ওষুধ খান, রোগ সারিয়ে দেবে।']) {
      expect(checkNarrative(bn(text), [], 'bn').ok).toBe(false);
    }
  });

  it('does not fire on look-alike words (routine, I, brown, sweet)', () => {
    const t = [...terms(['gluten']), ...terms(['tree_nuts']), ...avoidTermsFor(['other'], 'আম', undefined, 'bn')];
    expect(checkNarrative(bn('আমি আপনাকে একটি সহজ রুটিন সাজাতে সাহায্য করব, যাতে বাদামি চালের ভাত মিষ্টি অভ্যাস হয়ে ওঠে।'), t.filter((x) => x !== 'বাদামি'), 'bn').ok).toBe(true);
    expect(checkNarrative(bn('নানা রকম সবজি দিয়ে দুপুরের খাবার সাজান।'), t, 'bn').ok).toBe(true);
  });

  it('free-text allergens in Bangla script count too', () => {
    const t = avoidTermsFor(['other'], 'কাঁঠাল, আম', undefined, 'bn');
    expect(t).toEqual(expect.arrayContaining(['কাঁঠাল', 'আম']));
    expect(checkNarrative(bn('বিকেলে কাঁঠালের একটি টুকরো খেতে পারেন।'), t, 'bn').ok).toBe(false);
  });

  it('the English rules still apply to a Bangla reply that mixes in English', () => {
    expect(checkNarrative(bn('Aim for 1800 calories and drink water.'), [], 'bn').ok).toBe(false);
  });
});

describe('planInputHash', () => {
  it('is stable, ignores fields that do not feed the plan and changes with the ones that do', () => {
    const att = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false };
    const h = planInputHash(profile(), att);
    expect(planInputHash(profile(), att)).toBe(h);
    expect(planInputHash(profile({ displayName: 'Someone else', loggingMethods: ['photo'] }), att)).toBe(h);
    expect(planInputHash(profile({ weightKg: 81 }), att)).not.toBe(h);
    expect(planInputHash(profile({ allergies: ['peanuts', 'milk'] }), att)).not.toBe(h);
    expect(planInputHash(profile(), { ...att, eatingDisorderConcern: true })).not.toBe(h);
    expect(planInputHash(profile(), null)).not.toBe(h);
    expect(planInputHash(profile(), { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false })).toBe(h);
  });
});

describe('buildNarrativeContext', () => {
  const set = loadQuestionSet(loadContentJson('questions.v2.json'));
  const p = profile({ dietPattern: 'other', dietPatternOther: 'mostly plant based', allergies: ['peanuts', 'other'], allergyOther: 'kiwi' });
  const att = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false };
  const preview = calculatePlan({ ageYears: 34, calculationSex: 'female', heightCm: 168, weightKg: 82, activityLevel: 'light', goal: 'lose', targetWeightKg: 74, attestation: att });
  const ctx = buildNarrativeContext({ profile: p, preview, timeframe: null, assessment: assessPlan({ ...planInputs(p), attestation: att }), label: makeLabeler(set) });

  function planInputs(x: ProfileFields) {
    return { ageYears: x.ageYears, calculationSex: x.calculationSex, heightCm: x.heightCm, weightKg: x.weightKg, activityLevel: x.activityLevel, goal: x.primaryGoal, targetWeightKg: x.targetWeightKg };
  }

  it('never sends the name or date of birth, and speaks in labels not ids', () => {
    expect(ctx.context).not.toMatch(/Alex|Private|1991/);
    expect(ctx.context).toMatch(/Peanuts/);
    expect(ctx.context).toMatch(/Changing or rotating shifts/);
    expect(ctx.context).toMatch(/other \(user text\): kiwi/);
    expect(ctx.avoidTerms).toEqual(expect.arrayContaining(['peanut', 'kiwi']));
  });

  it('says "not provided" for unanswered allergies instead of assuming none', () => {
    const c = buildNarrativeContext({ profile: profile({ allergies: null }), preview, timeframe: null, assessment: assessPlan({ ...planInputs(p), attestation: att }), label: makeLabeler(set) });
    expect(c.context).toMatch(/"allergiesAndIntolerances": "not provided"/);
  });
});

describe('the prompt file', () => {
  it('carries the same output schema as the code that validates it', () => {
    const raw = readFileSync(join(__dirname, '../../../content/prompts/plan-narrative.v1.md'), 'utf8');
    const block = /## Output schema[\s\S]*?```json\s*([\s\S]*?)```/.exec(raw)![1]!;
    expect((JSON.parse(block) as { schema: unknown }).schema).toEqual(planNarrativeJsonSchema());
  });
});
