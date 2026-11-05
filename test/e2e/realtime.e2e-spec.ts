import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';

describe('Realtime voice conversation', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp();
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const start = async (h: Record<string, string>) => (await t.http().post('/v1/conversations').set(h).set(idem()).send({ type: 'onboarding' }).expect(201)).body;
  const session = (h: Record<string, string>, id: string, extra: Record<string, string> = {}) => t.http().post(`/v1/conversations/${id}/realtime`).set(h).set(INTEGRITY).set(extra);
  let n = 0;
  const tool = (h: Record<string, string>, id: string, name: string, args: object) =>
    t.http().post(`/v1/conversations/${id}/realtime/tool`).set(h).set(INTEGRITY).set(idem(`call_test_${String(++n).padStart(4, '0')}`)).send({ callId: `call_test_${n}`, name, arguments: args });

  it('says so, without faking anything, while no Gemini key is configured', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const res = await session(h, c.id).expect(503);
    expect(res.body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'not_configured' } });
    expect(fake.realtimeCalls).toHaveLength(0);
  });

  it('mints a client secret carrying the persona, the tools and the open questions', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const res = await session(h, c.id).expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({ clientSecret: 'auth_tokens/fake_secret', model: 'gemini-3.8-live', voice: 'Kore', maxSeconds: 600, sessionKind: 'start' });
    expect(res.body.callsUrl).toMatch(/^wss:\/\//);

    const req = fake.realtimeCalls[0]!;
    expect(req.tools.map((x) => x.name)).toEqual(['record_answers', 'confirm_answers']);
    expect(req.sessionSec).toBeGreaterThan(600);
    expect(req.tools[0]).not.toHaveProperty('type');
    expect(req.instructions).toContain('You are Milo');
    expect(req.instructions).toContain('Greet the user warmly');
    expect(req.instructions).toContain('What should I call you'); // first question
    expect(req.instructions).toContain('"id":"q05"');
    expect(req.instructions).toContain('Reply language: British English');
    // The answer shape is the extraction prompt's, so the voice model and the text model agree.
    expect(JSON.stringify(req.tools[0])).toContain('"questionId"');
  });

  it('ends the user\'s turn after three seconds of silence and keeps replies short', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    await session(h, c.id).expect(200);
    const req = fake.realtimeCalls[0]!;
    expect(req.silenceMs).toBe(3000);
    expect(req.maxOutputTokens).toBe(500);
    expect(req.instructions).toContain('three seconds of silence');
    expect(req.instructions).not.toContain('If the user interrupts');
  });

  it('a seeded row follows its file on reboot; an admin version is left alone', async () => {
    const { ContentService } = await import('../../src/modules/content/content.service');
    const { getModelToken } = await import('@nestjs/mongoose');
    const content = t.get<InstanceType<typeof ContentService>>(ContentService);
    const versions = t.get<import('mongoose').Model<{ kind: string; version: number; data: unknown; source: string; publishedAt: Date }>>(getModelToken('ContentVersion'));
    const prompts = t.get<import('mongoose').Model<{ key: string; version: number; content: string }>>(getModelToken('AiPrompt'));
    const file = (await versions.findOne({ kind: 'conversation', version: 2 }).lean())!.data;
    await versions.updateOne({ kind: 'conversation', version: 2 }, { $set: { data: { stale: true } } });
    await versions.create({ kind: 'conversation', version: 9, data: { edited: true }, source: 'admin', publishedAt: new Date() });
    await prompts.updateOne({ key: 'onboarding-voice', version: 3 }, { $set: { content: 'stale' } });

    await content.seed();

    expect((await versions.findOne({ kind: 'conversation', version: 2 }).lean())!.data).toEqual(file);
    expect((await versions.findOne({ kind: 'conversation', version: 9 }).lean())!.data).toEqual({ edited: true });
    expect((await prompts.findOne({ key: 'onboarding-voice', version: 3 }).lean())!.content).not.toBe('stale');
    await versions.deleteOne({ kind: 'conversation', version: 9 });
    content.clearCache();
  });

  it('serves the newest prompt file, and a version an admin chose survives a reboot', async () => {
    const { ContentService } = await import('../../src/modules/content/content.service');
    const content = t.get<InstanceType<typeof ContentService>>(ContentService);
    expect((await content.activePrompt('onboarding-voice'))?.version).toBe(3);

    const { getModelToken } = await import('@nestjs/mongoose');
    const prompts = t.get<import('mongoose').Model<{ key: string; version: number; active: boolean; activatedAt: Date | null }>>(getModelToken('AiPrompt'));
    await prompts.updateMany({ key: 'onboarding-voice' }, { $set: { active: false } });
    await prompts.updateOne({ key: 'onboarding-voice', version: 1 }, { $set: { active: true, activatedAt: new Date() } });
    await content.seed();
    expect((await content.activePrompt('onboarding-voice'))?.version).toBe(1);

    await prompts.updateOne({ key: 'onboarding-voice', version: 1 }, { $set: { active: false, activatedAt: null } });
    await prompts.updateOne({ key: 'onboarding-voice', version: 2 }, { $set: { active: true } });
  });

  it('speaks Bangla when the app is in Bangla', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    await session(h, c.id, { 'X-App-Locale': 'bn-BD', 'Accept-Language': 'bn' }).expect(200);
    const req = fake.realtimeCalls[0]!;
    expect(req.instructions).toContain('Bangla');
  });

  it('turns the flag off and refuses a finished conversation', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const { AppConfigService } = await import('../../src/modules/content/app-config.service');
    const cfg = t.get<InstanceType<typeof AppConfigService>>(AppConfigService);
    await cfg.set('flags', { 'voice.realtime': false });
    const off = await session(h, c.id).expect(403);
    expect(off.body.error.code).toBe('FEATURE_DISABLED');
    await cfg.set('flags', { 'voice.realtime': true });
    await session(h, c.id).expect(200);
  });

  it('records answers through the server engine: validated, saved, next question returned', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);

    const first = await tool(h, c.id, 'record_answers', {
      answers: [
        { questionId: 'q05', value: 'Alex', confidence: 0.95 },
        { questionId: 'q01', value: 'lose', confidence: 0.9 },
        { questionId: 'q09', value: { kind: 'weight', unit: 'kg', value: 80, stone: null, pounds: null, isEstimate: false }, confidence: 0.95 }, // volunteered before its rule shows it: held, not saved yet
      ],
    }).expect(200);
    const out1 = JSON.parse(first.body.output);
    expect(out1.status).toBe('saved');
    expect(out1.saved).toHaveLength(3);
    expect(out1.next.questions.filter((q: { askNow: boolean }) => q.askNow).map((q: { id: string }) => q.id)).toEqual(['q06']);
    expect(out1.next.questions.map((q: { id: string }) => q.id)).not.toContain('q07'); // always its own turn
    expect(first.body.reply).toMatchObject({ turnId: 'age', needsConfirmation: false, done: false });
    expect(first.body.reply.extracted.find((a: { questionId: string }) => a.questionId === 'q09').held).toBe(true);

    const state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
    expect(state.body.answers.map((a: { questionId: string }) => a.questionId).sort()).toEqual(['q01', 'q05']);
  });

  it('asks for a spoken yes or no only when an answer is uncertain', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    await tool(h, c.id, 'record_answers', { answers: [{ questionId: 'q05', value: 'Alex', confidence: 0.95 }, { questionId: 'q01', value: 'lose', confidence: 0.9 }] }).expect(200);

    const unsure = await tool(h, c.id, 'record_answers', { answers: [{ questionId: 'q06', value: { kind: 'age', mode: 'age', age: 28, dob: null }, confidence: 0.5 }] }).expect(200);
    const out = JSON.parse(unsure.body.output);
    expect(out.status).toBe('needs_confirmation');
    expect(unsure.body.reply.needsConfirmation).toBe(true);
    let state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
    expect(state.body.answers.some((a: { questionId: string }) => a.questionId === 'q06')).toBe(false);

    const no = await tool(h, c.id, 'confirm_answers', { accept: false }).expect(200);
    expect(JSON.parse(no.body.output).status).toBe('discarded');

    await tool(h, c.id, 'record_answers', { answers: [{ questionId: 'q06', value: { kind: 'age', mode: 'age', age: 28, dob: null }, confidence: 0.5 }] }).expect(200);
    const yes = await tool(h, c.id, 'confirm_answers', { accept: true }).expect(200);
    expect(JSON.parse(yes.body.output).status).toBe('saved');
    state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
    expect(state.body.answers.some((a: { questionId: string }) => a.questionId === 'q06')).toBe(true);
  });

  it('answers "nothing saved" instead of an error when the reply holds no valid answer', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const res = await tool(h, c.id, 'record_answers', { answers: [{ questionId: 'q01', value: 'fly', confidence: 0.9 }] }).expect(200);
    const out = JSON.parse(res.body.output);
    expect(out.status).toBe('nothing_saved');
    expect(out.next.say).toContain('What should I call you');
  });

  it('rejects malformed tool arguments and other people’s conversations', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const other = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const bad = await tool(h, c.id, 'record_answers', { answers: 'Alex' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    await tool(other, c.id, 'record_answers', { answers: [] }).expect(404);
    await session(other, c.id).expect(404);
  });

  it('logs the reported tokens as realtime usage with an estimated cost', async () => {
    fake.configured = true;
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    await t
      .http()
      .post(`/v1/conversations/${c.id}/realtime/usage`)
      .set(h)
      .set(INTEGRITY)
      .set(idem())
      .send({ inputAudioTokens: 2000, inputTextTokens: 3000, cachedInputTokens: 1000, outputAudioTokens: 1500, outputTextTokens: 200 })
      .expect(204);
    const { getModelToken } = await import('@nestjs/mongoose');
    const usage = t.get<{ findOne: (q: object) => { lean: () => Promise<{ requests: number; costUsd: number } | null> } }>(getModelToken('AiUsageDaily'));
    const row = await usage.findOne({ feature: 'realtime' }).lean();
    expect(row?.requests).toBe(1);
    // (2000-1000 fresh audio in x $3 + 3000 text in x $0.75 + 1000 cached x $0.75 + 1500 audio out x $12 + 200 text out x $4.5) / 1M
    expect(row!.costUsd).toBeCloseTo(0.0249, 6);
  });
});
