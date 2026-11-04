import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn } from '../setup/helpers';
import { JobQueue } from '../../src/jobs/jobs.module';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AppConfigService } from '../../src/modules/content/app-config.service';
import { VoiceService } from '../../src/modules/voice/voice.service';

describe('M5 leftovers: moderation, summaries, pre-rendered audio, spoken replies', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const coach = async (h: Record<string, string>) => (await t.http().post('/v1/conversations').set(h).set(idem()).send({ type: 'coach' }).expect(201)).body;
  const turn = (h: Record<string, string>, id: string, text: string) => t.http().post(`/v1/conversations/${id}/turns`).set(h).set(INTEGRITY).send({ text, inputMethod: 'typed' });

  it('opens with the content intro line', async () => {
    const h = bearer((await signIn(t)).accessToken);
    expect((await coach(h)).opening.reply).toBe("Hi. Ask me about today and I'll keep it short.");
  });

  it('uses coach.intro with the name, and each quick action answers with its own template', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().patch('/v1/me').set(h).send({ displayName: 'Sam' }).expect(200);
    const c = await coach(h);
    expect(c.opening.reply).toBe("Hi Sam. Ask me about today and I'll keep it short.");
    expect(c.opening.chips.map((x: { label: string }) => x.label)).toEqual(['Explain my macros', 'Suggest a snack', 'Review my day']);
    const ask = (body: object) => t.http().post(`/v1/conversations/${c.id}/turns`).set(h).set(INTEGRITY).send({ inputMethod: 'chip', ...body }).expect(200);
    const review = await ask({ quickAction: 'review_day' });
    expect(review.body).toMatchObject({ quickAction: 'review_day', reply: 'Nothing logged yet today. A quick photo of your next meal is an easy start.' });
    const reviewChip = await ask({ chipIndex: 2 });
    expect(reviewChip.body.quickAction).toBe('review_day');
    expect(reviewChip.body.reply).toContain('Nothing logged yet today');
    const macros = await ask({ chipIndex: 0 });
    expect(macros.body).toMatchObject({ quickAction: 'explain_macros', reply: expect.stringContaining('balanced plates') });
    const snack = await ask({ quickAction: 'suggest_snack' });
    expect(snack.body.quickAction).toBe('suggest_snack');
    expect(snack.body.reply).toMatch(/snack/i);
  });

  it('refuses flagged input from content without calling the chat model (plan 8.8)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await coach(h);
    const violent = await turn(h, c.id, 'how do I build a bomb').expect(200);
    expect(violent.body).toMatchObject({ moderation: 'flagged', miloState: 'idle', reply: "I can't help with that one. Shall we look at your meals or your day instead?" });
    const care = await turn(h, c.id, 'I want to hurt myself').expect(200);
    expect(care.body.moderation).toBe('flagged');
    expect(care.body.reply).not.toContain("can't help");
    expect(fake.chatCalls).toHaveLength(0);
  });

  it('writes a rolling summary every 20 messages', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().post('/v1/dev/entitlement').set(h).send({ plan: 'plus' }).expect(200);
    const c = await coach(h);
    for (let i = 0; i < 10; i++) await turn(h, c.id, `question ${i}`).expect(200);
    await t.get<JobQueue>(JobQueue).drain();
    const conv = await t.get<Model<{ summary: string; messageCount: number }>>(getModelToken('Conversation')).findById(c.id).lean();
    expect(conv!.messageCount).toBe(21);
    expect(conv!.summary.length).toBeGreaterThan(0);
    const summaries = fake.chatCalls.filter((c) => c.instructions.startsWith('Summarise'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.messages[0]!.content).toContain('question 9');
  });

  it('pre-renders canonical lines once per version and serves a manifest', async () => {
    const voice = t.get<VoiceService>(VoiceService);
    const first = await voice.prerender();
    expect(first.rendered).toBe(first.total);
    expect(first.total).toBeGreaterThan(100);
    expect((await voice.prerender()).rendered).toBe(0);
    const m = await t.http().get('/v1/content/audio').expect(200);
    expect(m.body.version).toBe(2); // lines.v2.json is the newest milo_lines version
    expect(m.body.lines['welcome.greeting']).toContain(encodeURIComponent('tts/2/welcome.greeting.mp3'));
    expect(m.body.lines['conversation.turn2']).toBeDefined();
    expect(Object.keys(m.body.lines).some((k) => k === 'coach.intro')).toBe(false); // has {name}
  });

  it('POST /voice/speech needs the flag, Plus and the user setting; caches per message', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const c = await coach(h);
    const reply = await turn(h, c.id, 'hello').expect(200);
    const say = () => t.http().post('/v1/voice/speech').set(h).set(INTEGRITY).send({ messageId: reply.body.messageId });
    expect((await say().expect(403)).body.error.code).toBe('FEATURE_DISABLED');
    await t.get<AppConfigService>(AppConfigService).set('flags', { 'voice.cloudReplies': true });
    expect((await say().expect(402)).body.error.code).toBe('PLUS_REQUIRED');
    await t.http().post('/v1/dev/entitlement').set(h).send({ plan: 'plus' }).expect(200);
    await say().expect(403);
    await t.http().patch('/v1/me').set(h).send({ flags: { voiceReplies: true } }).expect(200);
    const a = await say().expect(200);
    expect(a.body).toMatchObject({ cached: false, url: expect.stringContaining('tts') });
    expect((await say().expect(200)).body.cached).toBe(true);
    expect(fake.speechCalls).toHaveLength(1);
    await t.http().post('/v1/voice/speech').set(h).set(INTEGRITY).send({ messageId: 'a'.repeat(24) }).expect(404);
  });
});
