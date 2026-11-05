import { randomUUID } from 'node:crypto';
import { AiProvider, FakeAiProvider, PLAN_NARRATIVE_EXAMPLE } from '../../src/modules/ai/ai.provider';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn } from '../setup/helpers';

const BENGALI = /[ঀ-৿]/;
const answer = (questionId: string, value: unknown, detail?: unknown) => ({ questionId, value, ...(detail ? { detail } : {}), status: 'answered', inputMethod: 'form' });
const LOSE = [
  answer('q01', 'lose'),
  answer('q06', { mode: 'age', age: 34 }),
  answer('q07', 'female'),
  answer('q38', 'none'),
  answer('q08', { cm: 168, unit: 'cm' }),
  answer('q09', { kg: 82, unit: 'kg', isEstimate: false }),
  answer('q10', 'light'),
  answer('target_weight', { kg: 74, unit: 'kg' }),
  answer('q35', '26w'),
  answer('q36', ['milk']),
  answer('q11', 'none'),
];
const BN = { 'X-App-Locale': 'bn-BD', 'Accept-Language': 'bn' };

describe('Languages (decision 0007)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp({ RATE_LIMIT_MULTIPLIER: '100' });
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  afterAll(() => t.close());
  beforeEach(() => fake.reset());

  describe('content', () => {
    it('serves the Bangla question set with the same structure as English', async () => {
      const en = (await t.http().get('/v1/onboarding/questions').expect(200)).body;
      const bn = (await t.http().get('/v1/onboarding/questions?locale=bn').expect(200)).body;
      expect(en.locale).toBe('en');
      expect(bn.locale).toBe('bn');
      expect(bn.version).toBe(en.version);
      expect(bn.questionSet.questions.map((q: { id: string }) => q.id)).toEqual(en.questionSet.questions.map((q: { id: string }) => q.id));
      expect(bn.questionSet.questions[0].text).toMatch(BENGALI);
      expect(en.questionSet.questions[0].text).not.toMatch(BENGALI);
      const optionIds = (r: typeof en) => r.questionSet.questions.map((q: { options: { id: string }[] }) => q.options.map((o) => o.id));
      expect(optionIds(bn)).toEqual(optionIds(en));
      expect(bn.conversation.turns.length).toBe(en.conversation.turns.length);
    });

    it('picks the language from ?locale, X-App-Locale or Accept-Language, in that order, and falls back to English', async () => {
      const lang = async (req: { expect: (status: number) => PromiseLike<{ body: { locale: string } }> }) => (await req.expect(200)).body.locale;
      expect(await lang(t.http().get('/v1/onboarding/questions').set(BN))).toBe('bn');
      expect(await lang(t.http().get('/v1/onboarding/questions').set('Accept-Language', 'bn;q=0.9, en;q=0.5'))).toBe('bn');
      expect(await lang(t.http().get('/v1/onboarding/questions?locale=en').set(BN))).toBe('en');
      expect(await lang(t.http().get('/v1/onboarding/questions?locale=fr').set('Accept-Language', 'fr'))).toBe('en');
    });

    it('caches per language: different ETags, and the response varies on the language headers', async () => {
      const en = await t.http().get('/v1/onboarding/questions').expect(200);
      const bn = await t.http().get('/v1/onboarding/questions?locale=bn').expect(200);
      expect(en.headers.etag).not.toBe(bn.headers.etag);
      expect(String(bn.headers.vary)).toMatch(/Accept-Language/i);
      await t.http().get('/v1/onboarding/questions?locale=bn').set('If-None-Match', String(bn.headers.etag)).expect(304);
    });

    it('serves Milo lines and the conversation in Bangla', async () => {
      const lines = (await t.http().get('/v1/content/milo-lines?locale=bn').expect(200)).body;
      expect(lines.locale).toBe('bn');
      const en = (await t.http().get('/v1/content/milo-lines').expect(200)).body;
      expect(Object.keys(lines.data.lines).sort()).toEqual(Object.keys(en.data.lines).sort());
      expect(lines.data.lines['welcome.greeting'].text).toMatch(BENGALI);
      const conv = (await t.http().get('/v1/content/conversation?locale=bn').expect(200)).body;
      expect(conv.locale).toBe('bn');
      expect(JSON.stringify(conv.data.turns[1])).toMatch(BENGALI);
    });
  });

  describe('account language', () => {
    it('PATCH /me stores the tag for a supported language and refuses others', async () => {
      const h = bearer((await signIn(t)).accessToken);
      expect((await t.http().patch('/v1/me').set(h).send({ locale: 'bn' }).expect(200)).body.locale).toBe('bn-BD');
      expect((await t.http().patch('/v1/me').set(h).send({ locale: 'en-US' }).expect(200)).body.locale).toBe('en-GB');
      const res = await t.http().patch('/v1/me').set(h).send({ locale: 'fr-FR' }).expect(400);
      expect(res.body.error.details).toMatchObject({ field: 'locale' });
    });

    it('error messages follow the request language; English keeps the specific message', async () => {
      const email = `user-${randomUUID().slice(0, 8)}@example.com`;
      await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email }).expect(200);
      const body = { email, code: '000000', device: { deviceId: 'dev-1', platform: 'ios', appVersion: '1.0.0' } };
      const en = await t.http().post('/v1/auth/email/verify').send(body).expect(401);
      const bn = await t.http().post('/v1/auth/email/verify').set(BN).send(body).expect(401);
      expect(bn.body.error.code).toBe(en.body.error.code);
      expect(en.body.error.message).not.toMatch(BENGALI);
      expect(bn.body.error.message).toMatch(BENGALI);
    });
  });

  describe('plan in Bangla', () => {
    async function user() {
      const s = await signIn(t);
      const h = bearer(s.accessToken);
      await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'detailed', answers: LOSE }).expect(200);
      await t.http().post('/v1/onboarding/complete').set(h).send({}).expect(200);
      return h;
    }
    const generate = (h: Record<string, string>, extra: Record<string, string> = {}, body: object = {}) =>
      t.http().post('/v1/plan/generate').set(h).set(extra).set(idem()).send(body);

    it('every server-written text is in Bangla, with ASCII digits for the app to localise', async () => {
      const h = await user();
      const d = (await generate(h, BN).expect(200)).body;
      expect(d.locale).toBe('bn');
      expect(d.status).toBe('ready');
      expect(d.ai.message).toMatch(BENGALI); // key not configured: the honest message is in Bangla
      expect(d.basis.length).toBeGreaterThan(3);
      for (const line of d.basis) expect(line).toMatch(BENGALI);
      expect(d.timeframe.message).toMatch(BENGALI);
      expect(d.timeframe.message).toMatch(/\d/);
      expect(d.timeframe.message).not.toMatch(/[০-৯]/);
      for (const issue of d.assessment.issues) expect(issue.message).toMatch(BENGALI);
      const readiness = (await t.http().get('/v1/plan/readiness').set(h).set(BN).expect(200)).body;
      expect(readiness.outcome).toBe('ready');
    });

    it('the same answers in another language are a different draft; each keeps its own language', async () => {
      const h = await user();
      fake.configured = true;
      fake.enqueue(structuredClone(PLAN_NARRATIVE_EXAMPLE), structuredClone(PLAN_NARRATIVE_EXAMPLE));
      const bn = (await generate(h, BN).expect(200)).body;
      const bnAgain = (await generate(h, BN).expect(200)).body;
      expect(bnAgain.id).toBe(bn.id); // cached within the language
      const en = (await generate(h).expect(200)).body;
      expect(en.id).not.toBe(bn.id);
      expect(en.locale).toBe('en');
      expect(en.basis[0]).not.toMatch(BENGALI);
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0]!.context.startsWith('Reply language: Bangla')).toBe(true);
      expect(fake.calls[1]!.context).not.toMatch(/Reply language/);
      // The plan keeps the language of the draft that was confirmed, whatever language the confirm request is in.
      const plan = (await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: bn.id }).expect(201)).body;
      expect(plan.locale).toBe('bn');
      expect(plan.basis[0]).toMatch(BENGALI);
    });

    it('adjusted targets rebuild the basis in the draft\'s language', async () => {
      const h = await user();
      const d = (await generate(h, BN).expect(200)).body;
      const plan = (await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'adjusted', energyKcal: d.preview.calculated.energyKcal - 150, draftId: d.id }).expect(201)).body;
      expect(plan.locale).toBe('bn');
      expect(plan.basis.join(' ')).toMatch(/বদলে/);
      expect(plan.timeframe.message).toMatch(BENGALI);
    });

    it('the life stage notice is Bangla too, with no numbers', async () => {
      const h = await user();
      await t.http().put('/v1/onboarding/answers/q38').set(h).send({ value: 'pregnant', status: 'answered', inputMethod: 'form' }).expect(200);
      const d = (await generate(h, BN).expect(200)).body;
      expect(d.status).toBe('habits_only');
      expect(d.notice.title).toMatch(BENGALI);
      expect(d.notice.body).toMatch(BENGALI);
      expect(`${d.notice.title} ${d.notice.body}`).not.toMatch(/\d/);
    });

    it('rejects a Bangla narrative that names the allergen or states a figure (Bengali numerals included)', async () => {
      const h = await user(); // milk allergy
      fake.configured = true;
      const bad = structuredClone(PLAN_NARRATIVE_EXAMPLE);
      bad.summary = 'আপনার জন্য দিনে ১৮০০ ক্যালরি ঠিক আছে, সঙ্গে এক গ্লাস দুধ খেতে পারেন।';
      const good = structuredClone(PLAN_NARRATIVE_EXAMPLE);
      good.summary = 'আপনার রুটিন অনুযায়ী নিয়মিত সময়ে সহজ খাবার রাখলে সিদ্ধান্ত নেওয়া সহজ হয়, আর সংখ্যাগুলো একটি শুরুর বিন্দু মাত্র।';
      fake.enqueue(bad, good);
      const d = (await generate(h, BN).expect(200)).body;
      expect(d.ai.status).toBe('ok');
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]!.context).toMatch(/previous answer was rejected/);
      expect(d.narrative.summary).toBe(good.summary);
    });
  });

  describe('other AI features carry the reply language', () => {
    it('meal descriptions are parsed with the Bangla directive', async () => {
      const h = bearer((await signIn(t)).accessToken);
      await t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).set(BN).send({ text: 'দুটি ডিম আর একটি রুটি', inputMethod: 'typed' }).expect(200);
      expect(fake.calls[0]!.context.startsWith('Reply language: Bangla')).toBe(true);
      expect(fake.calls[0]!.context).toContain('দুটি ডিম আর একটি রুটি');
      fake.reset();
      await t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).send({ text: 'toast', inputMethod: 'typed' }).expect(200);
      expect(fake.calls[0]!.context).not.toMatch(/Reply language/);
    });

    it('the pre-rendered audio manifest is per language', async () => {
      const en = (await t.http().get('/v1/content/audio').expect(200)).body;
      const bn = (await t.http().get('/v1/content/audio?locale=bn').expect(200)).body;
      expect(en.locale).toBe('en');
      expect(bn.locale).toBe('bn');
    });
  });
});
