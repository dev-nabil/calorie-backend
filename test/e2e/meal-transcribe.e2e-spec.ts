import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AppConfigService } from '../../src/modules/content/app-config.service';
import { AI_LIMITS } from '../../src/shared';

/** A short 16 kHz mono WAV of silence (the fake provider does not listen). */
function wav(ms = 1500): Buffer {
  const samples = Math.round(16 * ms);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

describe('POST /v1/meals/transcribe (spoken food logging)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp();
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const send = (h: Record<string, string>, body: Buffer, type = 'audio/wav') => t.http().post('/v1/meals/transcribe').set(h).set(INTEGRITY).set('Content-Type', type).send(body);

  it('turns a recording into editable text; the audio goes to the model, nothing is saved or counted as a description', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const res = await send(h, wav()).expect(200);
    expect(res.body).toEqual({ status: 'ok', text: 'I ate 215 g of chicken pizza and a can of cola', language: 'en' });
    expect(fake.calls[0]).toMatchObject({ task: 'meal_transcribe', audio: { mimeType: 'audio/wav' } });
    expect(fake.calls[0]!.audio!.bytes.length).toBe(wav().length);
    // The describe allowance (3 a day for free accounts) is untouched by voice.
    for (let i = 0; i < 3; i++) await t.http().post('/v1/meals/describe').set(h).set(INTEGRITY).send({ text: 'toast' }).expect(200);
  });

  it('keeps Bangla text as spoken and trims it to what the composer takes', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue({ status: 'ok', text: '  আমি ২১৫ গ্রাম   চিকেন পিজ্জা খেয়েছি  ', language: 'bn' });
    expect((await send(h, wav(), 'audio/mp4').expect(200)).body).toEqual({ status: 'ok', text: 'আমি ২১৫ গ্রাম চিকেন পিজ্জা খেয়েছি', language: 'bn' });
    fake.enqueue({ status: 'ok', text: 'rice '.repeat(200), language: 'en' });
    expect((await send(h, wav()).expect(200)).body.text.length).toBeLessThanOrEqual(500);
  });

  it('says silence or unclear with no text, and an ok answer with no words is silence', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.mode = 'not_food';
    expect((await send(h, wav()).expect(200)).body).toEqual({ status: 'silence', text: '', language: null });
    fake.mode = 'ok';
    fake.enqueue({ status: 'unclear', text: '', language: null });
    expect((await send(h, wav()).expect(200)).body.status).toBe('unclear');
    fake.enqueue({ status: 'ok', text: '   ', language: 'en' });
    expect((await send(h, wav()).expect(200)).body.status).toBe('silence');
  });

  it('refuses a wrong type, an empty body, too much audio and malformed model output', async () => {
    const h = bearer((await signIn(t)).accessToken);
    expect((await send(h, wav(), 'text/plain').expect(400)).body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    await send(h, Buffer.alloc(10)).expect(400);
    await send(h, Buffer.alloc(2_100_000)).expect(413);
    fake.enqueue({ words: 'pizza' });
    expect((await send(h, wav()).expect(502)).body.error.code).toBe('AI_UNAVAILABLE');
    expect(fake.calls).toHaveLength(1);
  });

  it('needs a description left today and has its own daily cap', async () => {
    const h = bearer((await signIn(t)).accessToken);
    for (let i = 0; i < 3; i++) await t.http().post('/v1/meals/describe').set(h).set(INTEGRITY).send({ text: 'toast' }).expect(200);
    expect((await send(h, wav()).expect(402)).body.error.code).toBe('AI_LIMIT_REACHED');
    const h2 = bearer((await signIn(t)).accessToken);
    const cfg = t.get<AppConfigService>(AppConfigService);
    await cfg.set('limits', { ...AI_LIMITS, free: { ...AI_LIMITS.free, transcribePerDay: 2 } });
    await send(h2, wav()).expect(200);
    await send(h2, wav()).expect(200);
    expect((await send(h2, wav()).expect(402)).body.error).toMatchObject({ code: 'AI_LIMIT_REACHED', details: { limit: 2 } });
    await cfg.set('limits', AI_LIMITS);
  });

  it('is off with the extract kill switch, like describing', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const cfg = t.get<AppConfigService>(AppConfigService);
    await cfg.set('ai.kill.extract', true);
    expect((await send(h, wav()).expect(503)).body.error.code).toBe('AI_UNAVAILABLE');
    await cfg.set('ai.kill.extract', false);
  });
});
