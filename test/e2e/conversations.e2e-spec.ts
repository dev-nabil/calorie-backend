import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AppConfigService } from '../../src/modules/content/app-config.service';

describe('Conversations (M5-T1, T3, T4)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp();
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const start = async (h: Record<string, string>, type: 'onboarding' | 'coach') =>
    (await t.http().post('/v1/conversations').set(h).set(idem()).send({ type }).expect(201)).body;
  const turn = (h: Record<string, string>, id: string, body: object) => t.http().post(`/v1/conversations/${id}/turns`).set(h).set(INTEGRITY).send(body);
  const confirm = (h: Record<string, string>, id: string, accept: boolean) => t.http().post(`/v1/conversations/${id}/confirm`).set(h).send({ accept });

  describe('onboarding', () => {
    it('walks the turn groups with multi-answer confirmation and provisional height/weight', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      expect(c.opening).toMatchObject({ turnId: 'intro', chips: [{ index: 0, label: "Let's begin" }, { index: 1 }] });

      const begin = await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200);
      expect(begin.body).toMatchObject({ turnId: 'name_goal', questionIds: ['q05', 'q01'] });
      expect(begin.body.reply).toContain("Lovely, let's start.");

      const r1 = await turn(h, c.id, { text: "I'm Alex and I'd like to lose weight", inputMethod: 'voice' }).expect(200);
      expect(r1.body.needsConfirmation).toBe(true);
      expect(r1.body.extracted.map((a: { questionId: string }) => a.questionId).sort()).toEqual(['q01', 'q05']);
      expect(r1.body.reply).toContain("Here's what I noted");
      expect(fake.calls[0]!.context).toContain('"id":"q05"');

      const c1 = await confirm(h, c.id, true).expect(200);
      expect(c1.body).toMatchObject({ turnId: 'about_you', questionIds: ['q06', 'q08', 'q09'] });

      await turn(h, c.id, { text: "I'm 28, 172 cm and about 78 kg", inputMethod: 'voice' }).expect(200);
      const c2 = await confirm(h, c.id, true).expect(200);
      expect(c2.body).toMatchObject({ turnId: 'sex_input', questionIds: ['q07'] });
      let state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
      expect(state.body.answers.map((a: { questionId: string }) => a.questionId).sort()).toEqual(['q01', 'q05', 'q06']); // q08/q09 held

      const sex = await turn(h, c.id, { chipIndex: 1, inputMethod: 'chip' }).expect(200);
      expect(sex.body.turnId).toBe('target_weight');
      state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
      const q09 = state.body.answers.find((a: { questionId: string }) => a.questionId === 'q09');
      expect(q09).toMatchObject({ status: 'answered', value: { kg: 78, unit: 'kg', isEstimate: true } });
      expect(state.body.route).toBe('conversation');

      const skipTarget = await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200);
      expect(skipTarget.body.turnId).toBe('activity');
      await turn(h, c.id, { chipIndex: 1, inputMethod: 'chip' }).expect(200); // light
      await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200); // q11 none
      await turn(h, c.id, { chipIndex: 3, inputMethod: 'chip' }).expect(200); // q12 home
      await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200); // q22 busy
      const last = await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200); // q30 photo
      expect(last.body).toMatchObject({ done: true, miloState: 'celebrating' });
      expect(last.body.reply).toContain('Alex');
      const done = await t.http().post('/v1/onboarding/complete').set(h).send({ eligibility: { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false } }).expect(200);
      expect(done.body.preview).toMatchObject({ eligible: true, calculated: { energyKcal: 2129 } });

      const msgs = await t.http().get(`/v1/conversations/${c.id}/messages`).set(h).expect(200);
      expect(msgs.body.items.length).toBeGreaterThan(10);
      expect(msgs.body.items[0].role).toBe('assistant');
    });

    it('drops held height/weight for under-18 answers and skips turns 4–6', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200);
      await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200); // q01 habits
      fake.enqueue({ answers: [{ questionId: 'q05', value: 'Sam', confidence: 0.95 }], ack: 'Hi Sam.', clarify: null, userQuestion: null });
      const named = await turn(h, c.id, { text: 'Sam', inputMethod: 'typed' }).expect(200);
      expect(named.body).toMatchObject({ needsConfirmation: false, turnId: 'about_you' });
      await turn(h, c.id, { text: "I'm 16, 160 cm and 50 kg", inputMethod: 'typed' }).expect(200);
      const next = await confirm(h, c.id, true).expect(200);
      expect(next.body.turnId).toBe('food');
      const state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
      expect(state.body.answers.some((a: { questionId: string }) => a.questionId === 'q08')).toBe(false);
      expect(state.body.mode).toBe('habits_only');
    });

    it('Change discards the noted answers; questions keep the turn; errors are mapped', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200);
      await turn(h, c.id, { text: "I'm Jo and want to gain", inputMethod: 'typed' }).expect(200);
      const change = await confirm(h, c.id, false).expect(200);
      expect(change.body).toMatchObject({ reply: 'No problem. What should I change?', turnId: 'name_goal' });
      expect((await confirm(h, c.id, true).expect(409)).body.error.code).toBe('NOTHING_TO_CONFIRM');
      fake.enqueue({ answers: [], ack: 'It helps me tailor ideas to you.', clarify: null, userQuestion: 'Why do you need this?' });
      const q = await turn(h, c.id, { text: 'why do you ask?', inputMethod: 'typed' }).expect(200);
      expect(q.body.turnId).toBe('name_goal');
      expect(q.body.reply).toContain('It helps me tailor ideas to you.');
      await t.get<AppConfigService>(AppConfigService).set('ai.kill.extract', true);
      expect((await turn(h, c.id, { text: 'hello', inputMethod: 'typed' }).expect(503)).body.error.code).toBe('AI_UNAVAILABLE');
      await t.get<AppConfigService>(AppConfigService).set('ai.kill.extract', false);
      await turn(h, c.id, { inputMethod: 'typed' }).expect(400);
      await turn(h, c.id, { chipIndex: 9, inputMethod: 'chip' }).expect(400);
      const other = bearer((await signIn(t)).accessToken);
      expect((await turn(other, c.id, { text: 'hi', inputMethod: 'typed' }).expect(404)).body.error.code).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  describe('coach', () => {
    it('answers free chat and quick actions, with templates when the chat model is off', async () => {
      const s = await signIn(t);
      const h = bearer(s.accessToken);
      const c = await start(h, 'coach');
      expect(c.opening.chips.map((x: { label: string }) => x.label)).toEqual(['Explain my macros', 'Suggest a snack', 'Review my day']);
      const free = await turn(h, c.id, { text: 'What should I eat?', inputMethod: 'typed' }).expect(200);
      expect(free.body.reply).toContain('yoghurt');
      expect(fake.chatCalls[0]!.maxOutputTokens).toBe(300);
      await t.get<AppConfigService>(AppConfigService).set('ai.kill.chat', true);
      const review = await turn(h, c.id, { quickAction: 'review_day', inputMethod: 'chip' }).expect(200);
      expect(review.body).toMatchObject({ quickAction: 'review_day', reply: 'Nothing logged yet today. A quick photo of your next meal is an easy start.' });
      const macros = await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200);
      expect(macros.body.reply).toContain('balanced plates'); // habits-only: no numbers
      expect(macros.body.caption).toBe('Milo is resting, so this is a quick answer for now.');
      expect((await turn(h, c.id, { text: 'hi', inputMethod: 'typed' }).expect(503)).body.error.code).toBe('AI_UNAVAILABLE');
      await t.get<AppConfigService>(AppConfigService).set('ai.kill.chat', false);
    });

    it('streams replies as server-sent events', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'coach');
      fake.enqueue('Try some fruit and yoghurt.');
      const res = await turn(h, c.id, { text: 'snack?', inputMethod: 'typed' }).query({ stream: 'true' }).buffer(true).parse((r, cb) => {
        let data = '';
        r.on('data', (chunk: Buffer) => (data += chunk.toString()));
        r.on('end', () => cb(null, data));
      });
      expect(res.headers['content-type']).toContain('text/event-stream');
      const text = res.body as string;
      expect(text).toContain('event: delta');
      expect(text).toContain('event: done');
      expect(text).toContain('"reply":"Try some fruit and yoghurt."');
    });

    it('enforces the free daily coach limit (10)', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'coach');
      for (let i = 0; i < 10; i++) await turn(h, c.id, { text: `hi ${i}`, inputMethod: 'typed' }).expect(200);
      expect((await turn(h, c.id, { text: 'again', inputMethod: 'typed' }).expect(402)).body.error.code).toBe('AI_LIMIT_REACHED');
    });
  });
});
