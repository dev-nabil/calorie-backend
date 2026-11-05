import { parseModelOutput } from '../../../domain/nutrition-validator';
import { PLAN_EXAMPLE_ANALYSIS } from '../../../domain/nutrition-validator/fixtures';
import type { FoodVisionRequest } from './food-vision.provider';
import { foodScanResponseSchema, GeminiFoodProvider } from './gemini-food.provider';

const KEY = 'test-key-never-logged';
const req: FoodVisionRequest = {
  model: 'gemini-3.5-flash-lite',
  instructions: 'Static',
  context: 'Diet pattern: ',
  image: { bytes: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' },
  resolution: 'high',
  thinkingLevel: 'minimal',
  maxOutputTokens: 2560,
  timeoutMs: 1000,
};

const interaction = (text: string, over: Record<string, unknown> = {}) => ({
  id: 'x',
  status: 'completed',
  model: 'gemini-3.5-flash-lite',
  steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
  usage: { total_input_tokens: 1800, total_cached_tokens: 0, total_output_tokens: 400, total_thought_tokens: 30 },
  ...over,
});

describe('GeminiFoodProvider (mocked HTTP)', () => {
  const realFetch = global.fetch;
  let calls: { url: string; init: RequestInit }[];
  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
    }) as never;
  };
  const provider = new GeminiFoodProvider(KEY);

  beforeEach(() => (calls = []));
  afterAll(() => (global.fetch = realFetch));

  it('sends one compact request: photo out of Google storage, key in a header, no tools', async () => {
    respond(interaction(JSON.stringify(PLAN_EXAMPLE_ANALYSIS)));
    await provider.analyse(req);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      store: false,
      system_instruction: 'Static',
      generation_config: { max_output_tokens: 2560, thinking_level: 'minimal' },
      response_format: { type: 'text', mime_type: 'application/json' },
    });
    expect(body.tools).toBeUndefined();
    expect(body.previous_interaction_id).toBeUndefined();
    expect((body.input as unknown[])[1]).toEqual({ type: 'image', data: Buffer.from('jpeg-bytes').toString('base64'), mime_type: 'image/jpeg', resolution: 'high' });
  });

  it('leaves out controls Gemini 2.5 does not have', async () => {
    respond(interaction(JSON.stringify(PLAN_EXAMPLE_ANALYSIS)));
    await provider.analyse({ ...req, model: 'gemini-2.5-flash-lite' });
    const body = JSON.parse(calls[0]!.init.body as string) as { generation_config: object; input: object[] };
    expect(body.generation_config).toEqual({ max_output_tokens: 2560 });
    expect(body.input[1]).not.toHaveProperty('resolution');
  });

  it('returns parsed output and keeps thinking tokens apart', async () => {
    respond(interaction(JSON.stringify(PLAN_EXAMPLE_ANALYSIS)));
    const res = await provider.analyse(req);
    expect(parseModelOutput(res.output).ok).toBe(true);
    expect(res).toMatchObject({ truncated: false, usage: { inputTokens: 1800, outputTokens: 400, thoughtTokens: 30, cachedTokens: 0 } });
  });

  it('flags output cut off by the token limit and hands back text that will not validate', async () => {
    respond(interaction('{"status":"ok","items":[{"name":"Ri', { status: 'incomplete' }));
    const res = await provider.analyse(req);
    expect(res.truncated).toBe(true);
    expect(parseModelOutput(res.output).ok).toBe(false);
    expect(res.usage.outputTokens).toBe(400); // still billed, still recorded
  });

  it('survives malformed JSON', async () => {
    respond(interaction('not json at all'));
    expect(parseModelOutput((await provider.analyse(req)).output).ok).toBe(false);
  });

  it.each([[429], [500], [503]])('treats HTTP %i as transient', async (status) => {
    respond({ error: { message: 'busy' } }, status, { 'retry-after': '2' });
    await expect(provider.analyse(req)).rejects.toMatchObject({ kind: 'transient', status, retryAfterMs: 2000 });
  });

  it.each([[400], [403]])('treats HTTP %i as permanent', async (status) => {
    respond({ error: { message: 'no' } }, status);
    await expect(provider.analyse(req)).rejects.toMatchObject({ kind: 'permanent', status });
  });

  it('reports a timeout separately, because it may still be billed', async () => {
    global.fetch = jest.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as never;
    await expect(provider.analyse(req)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('never puts the key or the photo in an error', async () => {
    respond({ error: { message: `bad key ${KEY}` } }, 403);
    const e = await provider.analyse(req).catch((x: Error) => x);
    expect(String(e)).not.toContain(KEY);
    expect(String(e)).not.toContain(req.image.bytes.toString('base64'));
  });

  it('refuses a failed interaction', async () => {
    respond(interaction('{}', { status: 'failed' }));
    await expect(provider.analyse(req)).rejects.toMatchObject({ kind: 'permanent' });
  });
});

describe('response schema', () => {
  const schema = foodScanResponseSchema() as { properties: Record<string, Record<string, unknown>>; required: string[]; $schema?: string };
  const item = (schema.properties.items!.items as { properties: Record<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }> }).properties;

  it('stays simple enough for Gemini: a maxItems here is refused with HTTP 400 "too many states"', () => {
    expect(JSON.stringify(schema)).not.toMatch(/"maxItems"|"maxLength"/);
  });

  it('uses the nullable form Google documents', () => {
    expect(schema.$schema).toBeUndefined();
    expect(item.n!.properties!.kcal!.type).toEqual(['number', 'null']);
    expect(item.note!.type).toEqual(['string', 'null']);
  });

  it('lets a nullable enum be null', () => {
    expect(schema.properties.retake).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  });

  it('requires every field, so the reply always parses against the same zod schema', () => {
    expect(schema.required).toEqual(expect.arrayContaining(['status', 'items', 'assumptions', 'question', 'retake']));
  });
});
