import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AppConfigService } from '../../src/modules/content/app-config.service';

describe('POST /v1/meals/parse (M4-T4)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp();
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const parse = (h: Record<string, string>, body: object) => t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).send(body);

  it('turns a description into normalised items with server totals', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const res = await parse(h, { text: 'two scrambled eggs on toast', inputMethod: 'voice', category: 'breakfast' }).expect(200);
    expect(res.body.mealName).toBe('Scrambled eggs on toast');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ name: 'Scrambled eggs', point: null, kcalRecomputed: false });
    expect(res.body.items.map((i: { processing: string }) => i.processing)).toEqual(['whole', 'processed']);
    expect(res.body.totals.kcal).toBe(266);
    expect(fake.calls[0]).toMatchObject({ task: 'meal_parse' });
    expect(fake.calls[0]!.context).toContain('two scrambled eggs on toast');
    expect(fake.calls[0]!.context).toContain('Mode: describe');
  });

  it('add_item returns exactly one item and no meal name', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const res = await parse(h, { text: 'a teaspoon of olive oil', mode: 'add_item', existingItems: [{ name: 'Salad', grams: 100 }] }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.mealName).toBeNull();
  });

  it('enforces the free daily limit (3) with 402 AI_LIMIT_REACHED', async () => {
    const h = bearer((await signIn(t)).accessToken);
    for (let i = 0; i < 3; i++) await parse(h, { text: 'toast' }).expect(200);
    const res = await parse(h, { text: 'toast' }).expect(402);
    expect(res.body.error).toMatchObject({ code: 'AI_LIMIT_REACHED', details: { limit: 3, plan: 'free' } });
  });

  it('returns AI_UNAVAILABLE with Retry-After when the extract kill switch is on', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const cfg = t.get<AppConfigService>(AppConfigService);
    await cfg.set('ai.kill.extract', true);
    const res = await parse(h, { text: 'toast' }).expect(503);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('120');
    await cfg.set('ai.kill.extract', false);
  });

  it('rejects invalid model output and invalid input', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue({ nope: true });
    expect((await parse(h, { text: 'toast' }).expect(502)).body.error.code).toBe('AI_UNAVAILABLE');
    await parse(h, { text: '' }).expect(400);
    await parse(h, { text: 'x', mode: 'other' }).expect(400);
  });
});
