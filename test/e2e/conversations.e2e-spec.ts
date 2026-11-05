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
    const stateOf = async (h: Record<string, string>) => (await t.http().get('/v1/onboarding/state').set(h).expect(200)).body;
    const chip = (h: Record<string, string>, id: string, chipIndex: number) => turn(h, id, { chipIndex, inputMethod: 'chip' }).expect(200);
    const statusOf = (s: { answers: { questionId: string; status: string }[] }, id: string) => s.answers.find((a) => a.questionId === id)?.status;

    it('walks every turn for a man: never asks about pregnancy, mirrors every answer, and keeps them all to the end', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      expect(c.opening).toMatchObject({ turnId: 'intro', chips: [{ index: 0, label: "Let's begin" }, { index: 1 }] });

      const begin = await chip(h, c.id, 0);
      expect(begin.body).toMatchObject({ turnId: 'name_goal', questionIds: ['q05', 'q01'] });
      expect(begin.body.reply).toContain("Lovely, let's start.");

      const r1 = await turn(h, c.id, { text: "I'm Alex and I'd like to lose weight", inputMethod: 'voice' }).expect(200);
      expect(r1.body.needsConfirmation).toBe(true);
      expect(r1.body.extracted.map((a: { questionId: string }) => a.questionId).sort()).toEqual(['q01', 'q05']);
      expect(r1.body.reply).toContain("Here's what I noted");
      expect(fake.calls[0]!.context).toContain('"id":"q05"');

      const c1 = await confirm(h, c.id, true).expect(200);
      expect(c1.body).toMatchObject({ turnId: 'age', questionIds: ['q06'] });

      fake.enqueue({ answers: [{ questionId: 'q06', value: { kind: 'age', mode: 'age', age: 28, dob: null }, confidence: 0.95 }], ack: 'Noted.', clarify: null, userQuestion: null });
      const age = await turn(h, c.id, { text: "I'm 28", inputMethod: 'typed' }).expect(200);
      expect(age.body).toMatchObject({ turnId: 'sex_input', questionIds: ['q07'] });

      const sex = await chip(h, c.id, 1); // Male
      expect(sex.body).toMatchObject({ turnId: 'body', questionIds: ['q08', 'q09'] }); // no pregnancy question
      expect(sex.body.extracted).toEqual([expect.objectContaining({ questionId: 'q07', value: 'male', held: false })]);

      fake.enqueue({
        answers: [
          { questionId: 'q08', value: { kind: 'height', unit: 'cm', value: 172, feet: null, inches: null }, confidence: 0.95 },
          { questionId: 'q09', value: { kind: 'weight', unit: 'kg', value: 78, stone: null, pounds: null, isEstimate: true }, confidence: 0.9 },
        ],
        ack: 'Thanks.', clarify: null, userQuestion: null,
      });
      await turn(h, c.id, { text: '172 cm and about 78 kg', inputMethod: 'typed' }).expect(200);
      const body = await confirm(h, c.id, true).expect(200);
      expect(body.body.turnId).toBe('target_weight');
      expect(body.body.extracted.filter((a: { held: boolean }) => !a.held).map((a: { questionId: string }) => a.questionId).sort()).toEqual(['q08', 'q09']);
      let state = await stateOf(h);
      expect(state.answers.find((a: { questionId: string }) => a.questionId === 'q09')).toMatchObject({ status: 'answered', value: { kg: 78, unit: 'kg', isEstimate: true } });
      expect(state.route).toBe('conversation');

      const skipTarget = await chip(h, c.id, 0); // Not sure yet
      expect(skipTarget.body).toMatchObject({ turnId: 'activity', skipped: ['target_weight'] }); // no target, so no timeframe either
      const light = await chip(h, c.id, 1);
      expect(light.body.turnId).toBe('movement');
      expect(light.body.extracted).toEqual([expect.objectContaining({ questionId: 'q10', value: 'light' })]);
      const move = await chip(h, c.id, 0); // walking
      expect(move.body.turnId).toBe('food');
      const diet = await chip(h, c.id, 0); // q11 none
      expect(diet.body).toMatchObject({ turnId: 'food', questionIds: ['q12'] });
      expect(diet.body.chips.map((x: { index: number }) => x.index)).toEqual([3, 4, 5]); // only chips for what is still open
      const home = await chip(h, c.id, 3); // q12 home
      expect(home.body.turnId).toBe('allergies');
      await chip(h, c.id, 0); // q36 none
      await chip(h, c.id, 1); // q37 three
      await chip(h, c.id, 0); // q22 busy
      const last = await chip(h, c.id, 0); // q30 photo
      expect(last.body).toMatchObject({ done: true, miloState: 'celebrating' });
      expect(last.body.reply).toContain('Alex');
      expect(last.body.extracted).toEqual([expect.objectContaining({ questionId: 'q30', value: ['photo'] })]);

      // A device that missed something uploads it as deferred: nothing the server holds is lost.
      const deferred = ['q01', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11', 'q12', 'q22', 'q27', 'q30', 'q36', 'q37'].map((questionId) => ({ questionId, status: 'deferred', inputMethod: 'form' }));
      await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'conversation', answers: deferred }).expect(200);
      const done = await t.http().post('/v1/onboarding/complete').set(h).send({}).expect(200);
      expect(done.body.preview).toMatchObject({ eligible: true, calculated: { energyKcal: 2129 } });
      state = await stateOf(h);
      for (const id of ['q01', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11', 'q12', 'q22', 'q27', 'q30', 'q36', 'q37']) expect(statusOf(state, id)).toBe('answered');
      expect(statusOf(state, 'q38')).toBe('not_applicable');

      const msgs = await t.http().get(`/v1/conversations/${c.id}/messages`).set(h).expect(200);
      expect(msgs.body.items.length).toBeGreaterThan(10);
      expect(msgs.body.items[0].role).toBe('assistant');
    });

    it('asks a woman about pregnancy and goes straight to a habits goal path when she is pregnant', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      await chip(h, c.id, 0);
      await chip(h, c.id, 2); // q01 lose
      fake.enqueue({ answers: [{ questionId: 'q05', value: 'Mia', confidence: 0.95 }], ack: 'Hi Mia.', clarify: null, userQuestion: null });
      await turn(h, c.id, { text: 'Mia', inputMethod: 'typed' }).expect(200);
      fake.enqueue({ answers: [{ questionId: 'q06', value: { kind: 'age', mode: 'age', age: 31, dob: null }, confidence: 0.95 }], ack: 'Noted.', clarify: null, userQuestion: null });
      await turn(h, c.id, { text: '31', inputMethod: 'typed' }).expect(200);
      const sex = await chip(h, c.id, 0); // Female
      expect(sex.body).toMatchObject({ turnId: 'life_stage', questionIds: ['q38'] });
      const stage = await chip(h, c.id, 1); // Pregnant
      expect(stage.body.turnId).toBe('food'); // a habits goal needs no measurements, target or timeframe
      const state = await stateOf(h);
      expect(['target_weight', 'q35'].every((id) => !state.applicableQuestionIds.includes(id))).toBe(true);
    });

    it('does not ask for weight on its own once height is declined', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      await chip(h, c.id, 0);
      await chip(h, c.id, 2); // q01 lose
      fake.enqueue({ answers: [{ questionId: 'q05', value: 'Lee', confidence: 0.95 }], ack: 'Hi.', clarify: null, userQuestion: null });
      await turn(h, c.id, { text: 'Lee', inputMethod: 'typed' }).expect(200);
      fake.enqueue({ answers: [{ questionId: 'q06', value: { kind: 'age', mode: 'age', age: 31, dob: null }, confidence: 0.95 }], ack: 'Noted.', clarify: null, userQuestion: null });
      await turn(h, c.id, { text: '31', inputMethod: 'typed' }).expect(200);
      await chip(h, c.id, 1); // Male
      const declined = await chip(h, c.id, 0); // I'd rather not say
      expect(declined.body.skipped).toEqual(expect.arrayContaining(['q08', 'q09']));
      expect(declined.body.turnId).toBe('food');
      expect(statusOf(await stateOf(h), 'q08')).toBe('skipped');
    });

    it('never asks again what a reply already answered, and holds it until its rules show it', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      await chip(h, c.id, 0);
      fake.enqueue({
        answers: [
          { questionId: 'q05', value: 'Sam', confidence: 0.95 },
          { questionId: 'q01', value: 'lose', confidence: 0.95 },
          { questionId: 'q06', value: { kind: 'age', mode: 'age', age: 40, dob: null }, confidence: 0.95 },
          { questionId: 'q09', value: { kind: 'weight', unit: 'kg', value: 90, stone: null, pounds: null, isEstimate: false }, confidence: 0.95 },
          { questionId: 'q11', value: 'veg', confidence: 0.95 },
          { questionId: 'q07', value: 'male', confidence: 0.95 }, // always its own turn: dropped
        ],
        ack: 'Noted.', clarify: null, userQuestion: null,
      });
      const r = await turn(h, c.id, { text: "I'm Sam, 40, 90 kg, vegetarian, and a man who wants to lose weight", inputMethod: 'typed' }).expect(200);
      expect(fake.calls.at(-1)!.context).toContain('"askNow":false');
      expect(r.body.needsConfirmation).toBe(true);
      expect(r.body.extracted.map((a: { questionId: string }) => a.questionId)).not.toContain('q07');
      const next = await confirm(h, c.id, true).expect(200);
      expect(next.body).toMatchObject({ turnId: 'sex_input', questionIds: ['q07'] }); // age is not asked again
      const sex = await chip(h, c.id, 1);
      expect(sex.body).toMatchObject({ turnId: 'body', questionIds: ['q08'] }); // weight is already held
      expect(sex.body.reply).toBe('What height should I use?');
      fake.enqueue({ answers: [{ questionId: 'q08', value: { kind: 'height', unit: 'cm', value: 180, feet: null, inches: null }, confidence: 0.95 }], ack: '', clarify: null, userQuestion: null });
      const height = await turn(h, c.id, { text: '180', inputMethod: 'typed' }).expect(200);
      expect(height.body.extracted.map((a: { questionId: string }) => a.questionId).sort()).toEqual(['q08', 'q09']); // the held weight is saved and mirrored
      expect(height.body.turnId).toBe('target_weight');
      await chip(h, c.id, 0);
      await chip(h, c.id, 1); // activity
      const food = await chip(h, c.id, 0); // movement
      expect(food.body).toMatchObject({ turnId: 'food', questionIds: ['q12'] }); // q11 was volunteered
      expect(food.body.reply).toBe('Where do most of your meals come from?');
    });

    it('under 18 skips every body and calorie turn', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'onboarding');
      await chip(h, c.id, 0);
      await chip(h, c.id, 0); // q01 habits
      fake.enqueue({ answers: [{ questionId: 'q05', value: 'Sam', confidence: 0.95 }], ack: 'Hi Sam.', clarify: null, userQuestion: null });
      const named = await turn(h, c.id, { text: 'Sam', inputMethod: 'typed' }).expect(200);
      expect(named.body).toMatchObject({ needsConfirmation: false, turnId: 'age' });
      fake.enqueue({ answers: [{ questionId: 'q06', value: { kind: 'age', mode: 'age', age: 16, dob: null }, confidence: 0.95 }], ack: 'Noted.', clarify: null, userQuestion: null });
      const next = await turn(h, c.id, { text: "I'm 16", inputMethod: 'typed' }).expect(200);
      expect(next.body.turnId).toBe('food');
      const state = await stateOf(h);
      expect(state.answers.some((a: { questionId: string }) => a.questionId === 'q08')).toBe(false);
      expect(state.mode).toBe('habits_only');
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
      expect(fake.chatCalls[0]!.maxOutputTokens).toBe(700);
      await t.get<AppConfigService>(AppConfigService).set('ai.kill.chat', true);
      const review = await turn(h, c.id, { quickAction: 'review_day', inputMethod: 'chip' }).expect(200);
      expect(review.body).toMatchObject({ quickAction: 'review_day', reply: 'Nothing logged yet today. A quick photo of your next meal is an easy start.' });
      const macros = await turn(h, c.id, { chipIndex: 0, inputMethod: 'chip' }).expect(200);
      expect(macros.body.reply).toContain('balanced plates'); // habits-only: no numbers
      expect(macros.body.caption).toBe('Milo is resting, so this is a quick answer for now.');
      expect((await turn(h, c.id, { text: 'hi', inputMethod: 'typed' }).expect(503)).body.error.code).toBe('AI_UNAVAILABLE');
      await t.get<AppConfigService>(AppConfigService).set('ai.kill.chat', false);
    });

    it('answers in the language the person writes in, with their goal data and a clean history', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'coach');
      await turn(h, c.id, { text: 'Hola Milo, ¿qué ceno hoy?', inputMethod: 'typed' }).expect(200);
      const call = fake.chatCalls.at(-1)!;
      const last = call.messages.at(-1)!;
      expect(last.role).toBe('user');
      // The rule that makes Milo mirror the user's language, then the person's context and their message.
      expect(last.content).toContain('Reply in the same language and script as the user message below');
      expect(last.content).toContain('"mode":"habits_only"');
      expect(last.content).toContain('Hola Milo, ¿qué ceno hoy?');
      // The turn being answered is in the final message only, never also in the history.
      expect(call.messages.filter((m) => m.content.includes('Hola Milo'))).toHaveLength(1);
      expect(call.instructions).toContain('Reply in the language and script of the user');
      expect(call.instructions).not.toContain('Three sentences or fewer');
    });

    it('keeps a tapped chip in the history as the quick action it stood for', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const c = await start(h, 'coach');
      await turn(h, c.id, { chipIndex: 1, inputMethod: 'chip' }).expect(200);
      await turn(h, c.id, { text: 'and something savoury?', inputMethod: 'typed' }).expect(200);
      const history = fake.chatCalls.at(-1)!.messages.slice(0, -1);
      expect(history.find((m) => m.role === 'user')).toEqual({ role: 'user', content: 'Suggest a snack' });
      expect(history.map((m) => m.content).join('\n')).not.toMatch(/\[chip|\[suggest_snack\]/);
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
