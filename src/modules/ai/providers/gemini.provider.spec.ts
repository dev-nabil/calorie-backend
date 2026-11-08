import { pcmToWav, SILENT_WAV } from './wav';
import { GeminiProvider, LIVE_WS_URL, structuredParts, thinkingConfigFor, toContents, usageOf, voiceOrDefault } from './gemini.provider';

type Fake = jest.Mock;
const asAny = (p: GeminiProvider) => p as unknown as { client: { models: { generateContent: Fake; generateContentStream: Fake } }; alpha: { authTokens: { create: Fake } } };

function provider(): { p: GeminiProvider; generate: Fake; stream: Fake; createToken: Fake } {
  const p = new GeminiProvider('test-key');
  const generate = jest.fn();
  const stream = jest.fn();
  const createToken = jest.fn();
  asAny(p).client = { models: { generateContent: generate, generateContentStream: stream } };
  asAny(p).alpha = { authTokens: { create: createToken } };
  return { p, generate, stream, createToken };
}

const STRUCTURED = { task: 'meal_parse' as const, model: 'gemini-3.5-flash-lite', instructions: 'sys', context: 'two eggs', timeoutMs: 5000, maxOutputTokens: 500 };
const answer = (text: string, extra: Record<string, unknown> = {}) => ({ text, candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 5 }, ...extra });

describe('wav', () => {
  it('wraps PCM in a 44-byte RIFF header with the right sizes', () => {
    const pcm = Buffer.alloc(48_000);
    const wav = pcmToWav(pcm, 24_000);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000); // bytes per second, 16-bit mono
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.length).toBe(44 + pcm.length);
    expect(SILENT_WAV.subarray(0, 4).toString()).toBe('RIFF');
  });
});

describe('helpers', () => {
  it('maps thinking effort to a level on Gemini 3 and a token budget on Gemini 2.5', () => {
    expect(thinkingConfigFor('gemini-3.5-flash-lite', 'minimal')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(thinkingConfigFor('gemini-3.8-flash', 'low')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('gemini-3.1-pro-preview', 'minimal')).toEqual({ thinkingLevel: 'LOW' }); // Pro cannot switch thinking off
    expect(thinkingConfigFor('gemini-2.5-flash-lite', 'minimal')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor('gemini-2.5-pro', 'minimal')).toEqual({ thinkingBudget: 128 });
    expect(thinkingConfigFor('gemini-2.5-flash', 'high')).toEqual({ thinkingBudget: -1 });
  });

  it('bills thinking tokens as output', () => {
    expect(usageOf({ promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 5 })).toEqual({ inputTokens: 100, cachedTokens: 40, outputTokens: 25 });
    expect(usageOf(undefined)).toEqual({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  });

  it('builds contents that start with the user and alternate', () => {
    expect(
      toContents([
        { role: 'assistant', content: 'Hi, I am Milo' },
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'and one more thing' },
        { role: 'assistant', content: 'sure' },
        { role: 'user', content: '  ' },
        { role: 'user', content: 'thanks' },
      ]),
    ).toEqual([
      { role: 'user', parts: [{ text: 'hello' }, { text: 'and one more thing' }] },
      { role: 'model', parts: [{ text: 'sure' }] },
      { role: 'user', parts: [{ text: 'thanks' }] },
    ]);
  });

  it('keeps a Gemini voice (any case) and replaces anything else, such as a name from before Gemini', () => {
    expect(voiceOrDefault('kore')).toBe('Kore');
    expect(voiceOrDefault('Puck')).toBe('Puck');
    expect(voiceOrDefault('marin')).toBe('Kore');
    expect(voiceOrDefault('alloy', 'Puck')).toBe('Puck');
    expect(voiceOrDefault(undefined)).toBe('Kore');
  });
});

describe('GeminiProvider.structured', () => {
  it('sends the schema, instructions and thinking level, and returns parsed JSON with usage', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValue(answer('{"mealName":"Eggs"}'));
    const r = await p.structured(STRUCTURED, { $schema: 'x', type: 'object', properties: { mealName: { anyOf: [{ type: 'string' }, { type: 'null' }] } } });
    expect(r).toEqual({ output: { mealName: 'Eggs' }, usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 25 }, model: 'gemini-3.5-flash-lite' });
    const call = generate.mock.calls[0]![0];
    expect(call.model).toBe('gemini-3.5-flash-lite');
    expect(call.contents).toEqual([{ role: 'user', parts: [{ text: 'two eggs' }] }]);
    expect(call.config).toMatchObject({ systemInstruction: 'sys', responseMimeType: 'application/json', maxOutputTokens: 500, thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(call.config.responseJsonSchema).toEqual({ type: 'object', properties: { mealName: { type: ['string', 'null'] } } }); // no $schema, nullable folded
    expect(call.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('passes the caller thinking effort through', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValue(answer('{}'));
    await p.structured({ ...STRUCTURED, task: 'plan_narrative', thinking: 'low' });
    expect(generate.mock.calls[0]![0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('sends a photo before the text, with its resolution on Gemini 3 only (fridge chef)', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValue(answer('{"notFood":true,"ingredients":[],"ideas":[]}'));
    const image = { bytes: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' as const, resolution: 'high' as const };
    await p.structured({ ...STRUCTURED, task: 'fridge_chef', context: 'Mode: full', image });
    const call = generate.mock.calls[0]![0];
    expect(call.contents).toEqual([
      { role: 'user', parts: [{ inlineData: { data: Buffer.from('jpeg-bytes').toString('base64'), mimeType: 'image/jpeg' }, mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' } }, { text: 'Mode: full' }] },
    ]);
    // The fridge chef schema goes through the API (no size keywords: Gemini refuses some of them).
    expect(JSON.stringify(call.config.responseJsonSchema)).not.toMatch(/maxItems|maxLength|\$schema/);
    expect(call.config.responseJsonSchema.required).toEqual(['notFood', 'ingredients', 'ideas']);
    expect(structuredParts({ model: 'gemini-2.5-flash-lite', context: 'x', image })[0]).not.toHaveProperty('mediaResolution');
    expect(structuredParts({ model: 'gemini-3.5-flash-lite', context: 'x' })).toEqual([{ text: 'x' }]);
  });

  it('fails with a status AiService can act on: cut off = 502 (retry), blocked/empty = 422, not JSON = 502', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValueOnce({ text: '{"a"', candidates: [{ finishReason: 'MAX_TOKENS' }] });
    await expect(p.structured(STRUCTURED)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('MAX_TOKENS') });
    generate.mockResolvedValueOnce({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(p.structured(STRUCTURED)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('SAFETY') });
    generate.mockResolvedValueOnce({ text: '', candidates: [{ finishReason: 'SAFETY' }] });
    await expect(p.structured(STRUCTURED)).rejects.toMatchObject({ status: 422 });
    generate.mockResolvedValueOnce(answer('not json'));
    await expect(p.structured(STRUCTURED)).rejects.toMatchObject({ status: 502 });
  });

  it('lets SDK errors through with their HTTP status', async () => {
    const { p, generate } = provider();
    generate.mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));
    await expect(p.structured(STRUCTURED)).rejects.toMatchObject({ status: 429 });
  });
});

describe('GeminiProvider.streamChat', () => {
  async function* chunks(...items: Array<Record<string, unknown>>) {
    for (const i of items) yield i;
  }

  it('streams deltas, maps assistant to model and reads usage from the last chunk', async () => {
    const { p, stream } = provider();
    stream.mockResolvedValue(chunks({ text: 'Try ' }, { text: 'apple slices.' }, { text: '', usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 6 } }));
    const got: string[] = [];
    const r = await p.streamChat({ model: 'gemini-3.5-flash-lite', instructions: 'You are Milo', messages: [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: 'snack?' }], timeoutMs: 5000, maxOutputTokens: 300 }, (d) => got.push(d));
    expect(got).toEqual(['Try ', 'apple slices.']);
    expect(r).toEqual({ output: 'Try apple slices.', usage: { inputTokens: 30, cachedTokens: 0, outputTokens: 6 }, model: 'gemini-3.5-flash-lite' });
    expect(stream.mock.calls[0]![0].contents).toEqual([{ role: 'user', parts: [{ text: 'snack?' }] }]);
    expect(stream.mock.calls[0]![0].config.systemInstruction).toBe('You are Milo');
  });

  it('fails when nothing came back', async () => {
    const { p, stream } = provider();
    stream.mockResolvedValue(chunks({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(p.streamChat({ model: 'm', instructions: '', messages: [{ role: 'user', content: 'x' }], timeoutMs: 1000, maxOutputTokens: 10 }, () => undefined)).rejects.toMatchObject({ status: 422 });
  });
});

describe('GeminiProvider.moderate', () => {
  it('flags the categories the classifier reports and drops anything outside the list', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValue(answer('{"categories":["self-harm","made-up","self-harm"]}'));
    expect(await p.moderate('I want to hurt myself', 'gemini-3.5-flash-lite')).toEqual({ flagged: true, categories: ['self-harm'] });
    const cfg = generate.mock.calls[0]![0];
    expect(cfg.contents[0].parts[0].text).toContain('<message>\nI want to hurt myself\n</message>');
    expect(cfg.config.safetySettings).toHaveLength(4);
    expect(cfg.config.temperature).toBe(0);
  });

  it('does not flag an empty list, and ignores a "flagged" field the model made up', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValue(answer('{"categories":[],"flagged":true}'));
    expect(await p.moderate('what is a good snack', 'm')).toEqual({ flagged: false, categories: [] });
  });

  it('treats a prompt Google blocks as flagged, and fails closed on a provider error', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValueOnce({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
    expect(await p.moderate('bad', 'm')).toEqual({ flagged: true, categories: ['blocked'] });
    generate.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }));
    await expect(p.moderate('hi', 'm')).rejects.toMatchObject({ status: 503 });
    generate.mockResolvedValueOnce(answer('nope'));
    await expect(p.moderate('hi', 'm')).rejects.toMatchObject({ status: 502 });
  });
});

describe('GeminiProvider.speech', () => {
  it('asks for audio with the chosen voice and returns the PCM as WAV at the reported rate', async () => {
    const { p, generate } = provider();
    const pcm = Buffer.alloc(2400);
    generate.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] });
    const r = await p.speech({ model: 'gemini-3.8-flash-lite-tts', voice: 'alloy', text: 'Hello', timeoutMs: 1000 });
    expect(r.contentType).toBe('audio/wav');
    expect(r.audio.length).toBe(44 + pcm.length);
    expect(r.audio.readUInt32LE(24)).toBe(24_000);
    const cfg = generate.mock.calls[0]![0].config;
    expect(cfg.responseModalities).toEqual(['AUDIO']);
    expect(cfg.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore'); // a voice name from before Gemini falls back
  });

  it('fails when there is no audio', async () => {
    const { p, generate } = provider();
    generate.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] });
    await expect(p.speech({ model: 'm', voice: 'Kore', text: 'x', timeoutMs: 1000 })).rejects.toMatchObject({ status: 422 });
  });
});

describe('GeminiProvider.realtimeSecret', () => {
  const req = {
    model: 'gemini-3.8-live',
    voice: 'Kore',
    instructions: 'You are Milo',
    tools: [{ name: 'record_answers', description: 'save', parameters: { type: 'object', properties: {} } }],
    expiresAfterSec: 120,
    sessionSec: 660,
    maxOutputTokens: 500,
    silenceMs: 3000,
    timeoutMs: 5000,
  };

  it('mints a one-use token with the whole session locked into it', async () => {
    const { p, createToken } = provider();
    createToken.mockResolvedValue({ name: 'auth_tokens/abc' });
    const before = Math.floor(Date.now() / 1000);
    const s = await p.realtimeSecret(req);
    expect(s).toMatchObject({ value: 'auth_tokens/abc', model: 'gemini-3.8-live', callsUrl: LIVE_WS_URL });
    expect(s.callsUrl).toMatch(/^wss:\/\/.*BidiGenerateContentConstrained$/);
    expect(s.expiresAt).toBeGreaterThanOrEqual(before + 119);
    expect(s.expiresAt).toBeLessThanOrEqual(before + 122);
    const { config } = createToken.mock.calls[0]![0];
    expect(config.uses).toBe(1);
    expect(Date.parse(config.expireTime) - Date.parse(config.newSessionExpireTime)).toBe(660_000);
    expect(config.lockAdditionalFields).toBeUndefined(); // the constraints lock everything they set
    const live = config.liveConnectConstraints;
    expect(live.model).toBe('gemini-3.8-live');
    expect(live.config).toMatchObject({
      responseModalities: ['AUDIO'],
      systemInstruction: 'You are Milo',
      maxOutputTokens: 500,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      tools: [{ functionDeclarations: [{ name: 'record_answers', description: 'save', parametersJsonSchema: { type: 'object', properties: {} } }] }],
      realtimeInputConfig: { activityHandling: 'NO_INTERRUPTION', automaticActivityDetection: { silenceDurationMs: 3000, prefixPaddingMs: 300 } },
    });
  });

  it('fails when Google returns no token', async () => {
    const { p, createToken } = provider();
    createToken.mockResolvedValue({});
    await expect(p.realtimeSecret(req)).rejects.toMatchObject({ status: 502 });
  });
});
