/** A plate in the model's output format, used by tests and the fake provider. Totals 501 kcal. */
export const PLAN_EXAMPLE_ANALYSIS = {
  isEdible: true,
  hazard: null,
  miloWarning: null,
  status: 'ok',
  box_2d: [120, 90, 900, 950],
  mealName: 'Grilled chicken with rice and greens',
  items: [
    {
      name: 'Grilled chicken breast',
      en: 'grilled chicken breast',
      ves: 'plate', cm: 26, pcs: 1, g: 150,
      prep: 'grilled',
      proc: 'whole',
      role: 'single',
      of: null,
      n: { kcal: 165, p: 31, c: 0, f: 3.6, fib: 0, sug: 0, na: 74 },
      rich: ['vitaminB12', 'zinc', 'potassium'],
      conf: 0.82,
      pt: { x: 0.54, y: 0.74 },
      note: null,
    },
    {
      name: 'White rice, cooked',
      en: 'long grain rice',
      ves: 'plate', cm: 26, pcs: 1, g: 160,
      prep: 'boiled',
      proc: 'whole',
      role: 'single',
      of: null,
      n: { kcal: 130, p: 2.7, c: 28.1, f: 0.3, fib: 0.4, sug: 0.1, na: 1 },
      rich: [],
      conf: 0.74,
      pt: { x: 0.2, y: 0.68 },
      note: null,
    },
    {
      name: 'Cooking oil',
      en: 'cooking oil',
      ves: 'plate', cm: 26, pcs: 1, g: 5,
      prep: 'unknown',
      proc: 'processed',
      role: 'single',
      of: null,
      n: { kcal: 900, p: 0, c: 0, f: 100, fib: 0, sug: 0, na: 0 },
      rich: ['vitaminE'],
      conf: 0.4,
      pt: null,
      note: 'Oil is not visible; the amount may be low.',
    },
  ],
  assumptions: ['Oil is not visible; the amount may be low.'],
  question: null,
  retake: null,
} as const;

/**
 * Thorny wild nightshade berries (kantakari) as meal-scan.v8 should answer: unsafe, with the reason. The model also
 * slipped in an item with nutrition and vitamins, which the server must drop.
 */
export const UNSAFE_EXAMPLE = {
  isEdible: false,
  hazard: 'danger',
  miloWarning: 'These look like thorny wild nightshade berries (kantakari). They contain solanine, which is toxic, so do not eat them.',
  status: 'ok',
  box_2d: [180, 120, 860, 900],
  mealName: 'Wild nightshade berries',
  items: [
    {
      name: 'Nightshade berries',
      en: 'nightshade berries',
      ves: 'plate', cm: 24, pcs: 8, g: 6,
      prep: 'raw',
      proc: 'whole',
      role: 'single',
      of: null,
      n: { kcal: 25, p: 1, c: 5, f: 0.2, fib: 2, sug: 3, na: 2 },
      rich: ['vitaminC'],
      conf: 0.7,
      pt: { x: 0.5, y: 0.5 },
      note: null,
    },
  ],
  assumptions: ['Portion is about one plate.'],
  question: 'Are these wild berries?',
  retake: null,
} as const;

/** A biscuit pack's nutrition table as Gemini would copy it (label-scan.v2): printed per 100 g, serving 25 g. */
export const LABEL_EXAMPLE = {
  status: 'ok',
  name: 'Bisk Club Chocolate Biscuits',
  en: 'chocolate biscuits',
  basis: 'per_100g',
  servingG: 25,
  servingText: '3 biscuits (25 g)',
  packG: 75,
  n: { kcal: 480, kj: 2010, p: 6.5, c: 66, f: 21, fib: 2, sug: 28, na: null, salt: 0.6 },
  rich: [],
  proc: 'ultra_processed',
  question: null,
  retake: null,
} as const;
