import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, DESCRIBE_EXAMPLE, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AppConfigService } from '../../src/modules/content/app-config.service';

const item = (over: Record<string, unknown> = {}) => ({ ...structuredClone(DESCRIBE_EXAMPLE.items[0]!), ...over });
/** A window around today in every timezone (GET /meals allows at most 93 days). */
const around = () => {
  const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  return { from: d(-2), to: d(2) };
};
const answer = (items: object[], over: Record<string, unknown> = {}) => ({ ...structuredClone(DESCRIBE_EXAMPLE), items, ...over });

describe('POST /v1/meals/describe (text logging)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp();
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const describeMeal = (h: Record<string, string>, body: object) => t.http().post('/v1/meals/describe').set(h).set(INTEGRITY).send(body);

  it('returns a draft with the stated weight, server values and a matching meal total; nothing is saved', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const res = await describeMeal(h, { text: 'I ate 215 g of chicken pizza and a can of cola', category: 'lunch' }).expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ name: 'Chicken pizza', grams: 215, kcal: 538, proteinG: 25.8, quantityStated: true, assumption: 'Assumed regular crust', per100g: { kcal: 250 } });
    expect(res.body.items[1]).toMatchObject({ name: 'Cola', grams: 330, kcal: 139 });
    expect(res.body.totals).toMatchObject({ kcal: 538 + 139, incomplete: [] });
    expect(fake.calls[0]).toMatchObject({ task: 'meal_describe' });
    expect(fake.calls[0]!.context).toContain('I ate 215 g of chicken pizza');
    const meals = await t.http().get('/v1/meals').query(around()).set(h).expect(200);
    expect(meals.body.items).toHaveLength(0);
  });

  it('sends the draft and earlier messages with a correction, and keeps that food\'s basis', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue(answer([item({ qty: 150, g: 150, portion: '150 g', n: { kcal: 300, p: 10, c: 30, f: 15, fib: 2, sug: 3, na: 500 } })]));
    const draft = { mealName: 'Chicken pizza', items: [{ name: 'Chicken pizza', grams: 215, portion: '215 g', per100g: { kcal: 250, proteinG: 12, carbsG: 28, fatG: 10, fiberG: 2, sugarG: 3, sodiumMg: 560 } }] };
    const res = await describeMeal(h, { text: 'Actually, it was 150 g', history: ['I ate 215 g of chicken pizza'], draft }).expect(200);
    expect(res.body.items[0]).toMatchObject({ grams: 150, kcal: 375, quantityStated: true });
    expect(res.body.totals.kcal).toBe(375);
    const ctx = fake.calls[0]!.context;
    expect(ctx).toContain('Actually, it was 150 g');
    expect(ctx).toContain('["I ate 215 g of chicken pizza"]');
    expect(ctx).toContain('"grams":215');
    expect(ctx).not.toContain('per100g'); // the model gets names and amounts, not numbers to copy
  });

  it('asks one short question when an amount that matters is missing, and keeps the assumed draft', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue(answer([item({ name: 'Rice', en: 'unlisted rice', stated: false, qty: null, unit: null, g: 250, assume: 'Assumed 1 plate' })], { status: 'needs_info', question: 'How many plates of rice?' }));
    const res = await describeMeal(h, { text: 'I had rice for lunch' }).expect(200);
    expect(res.body).toMatchObject({ status: 'needs_info', clarifyingQuestion: 'How many plates of rice?' });
    expect(res.body.items[0]).toMatchObject({ quantityStated: false, assumption: 'Assumed 1 plate' });
  });

  it('answers not_food with a question and no items', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.mode = 'not_food';
    const res = await describeMeal(h, { text: 'hello, how are you?' }).expect(200);
    expect(res.body).toMatchObject({ status: 'not_food', items: [], clarifyingQuestion: 'What did you eat?' });
  });

  it('rejects malformed model output (502) and invalid input (400)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue({ nope: true });
    expect((await describeMeal(h, { text: 'toast' }).expect(502)).body.error.code).toBe('AI_UNAVAILABLE');
    fake.enqueue(answer([item({ g: '215' })]));
    expect((await describeMeal(h, { text: 'toast' }).expect(502)).body.error.code).toBe('AI_UNAVAILABLE');
    await describeMeal(h, { text: '' }).expect(400);
    await describeMeal(h, { text: 'x', draft: { items: [] } }).expect(400);
    await describeMeal(h, { text: 'x', draft: { items: [{ name: 'Rice', grams: 99999 }] } }).expect(400);
    await describeMeal(h, { text: 'x', history: Array(7).fill('a') }).expect(400);
  });

  it('shares the daily describe allowance with /meals/parse; failures are not counted', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue({ nope: true });
    await describeMeal(h, { text: 'toast' }).expect(502);
    await describeMeal(h, { text: 'toast' }).expect(200);
    await t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).send({ text: 'toast' }).expect(200);
    await describeMeal(h, { text: 'toast' }).expect(200);
    const res = await describeMeal(h, { text: 'toast' }).expect(402);
    expect(res.body.error).toMatchObject({ code: 'AI_LIMIT_REACHED', details: { limit: 3, plan: 'free' } });
  });

  it('returns AI_UNAVAILABLE when the extract kill switch is on', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const cfg = t.get<AppConfigService>(AppConfigService);
    await cfg.set('ai.kill.extract', true);
    const res = await describeMeal(h, { text: 'toast' }).expect(503);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    await cfg.set('ai.kill.extract', false);
  });

  it('a reviewed draft saves through POST /meals once, however often the same request is retried', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const draft = (await describeMeal(h, { text: 'I ate 215 g of chicken pizza and a can of cola' }).expect(200)).body;
    const body = {
      loggedAt: new Date().toISOString(),
      timezone: 'Asia/Dhaka',
      category: 'lunch',
      name: draft.mealName,
      source: 'text',
      items: draft.items.map((i: { name: string; grams: number; kcal: number; proteinG: number; carbsG: number; fatG: number; per100g: object; processing: string }) => ({
        name: i.name, grams: i.grams, kcal: i.kcal, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG, per100g: i.per100g, processing: i.processing,
      })),
    };
    const key = 'text-log-0001-retry';
    const first = await t.http().post('/v1/meals').set(h).set('Idempotency-Key', key).send(body).expect(201);
    const again = await t.http().post('/v1/meals').set(h).set('Idempotency-Key', key).send(body).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(first.body.totals.kcal).toBe(draft.totals.kcal);
    const meals = await t.http().get('/v1/meals').query(around()).set(h).expect(200);
    expect(meals.body.items).toHaveLength(1);
  });
});
