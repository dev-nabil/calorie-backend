import OpenAI from 'openai';
import { z } from 'zod';
import { MealAnalysisOutputSchema, MealParseOutputSchema, PlanNarrativeOutputSchema } from '../../shared';
import { PLAN_EXAMPLE_ANALYSIS } from '../../domain/nutrition-validator/fixtures';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type AiTask = 'meal_scan' | 'meal_parse' | 'onboarding_extract' | 'plan_narrative';

export interface StructuredRequest {
  task: AiTask;
  model: string;
  /** Static prefix first so OpenAI prompt caching applies (S-18). */
  instructions: string;
  context: string;
  imageUrl?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  /** false = ask OpenAI not to retain the request and response (health-related inputs). */
  store?: boolean;
  /** Reasoning models only (gpt-5, o-series): how much thinking to spend. Writing tasks do not need much. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface ChatRequest {
  model: string;
  instructions: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface AiResult {
  output: unknown;
  usage: AiUsage;
  model: string;
}

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

export interface SpeechRequest {
  model: string;
  voice: string;
  text: string;
  timeoutMs: number;
}

/** What the server asks OpenAI to put into the ephemeral client secret of a Realtime session. */
export interface RealtimeSecretRequest {
  model: string;
  voice: string;
  instructions: string;
  tools: Array<Record<string, unknown>>;
  /** Input transcription model and a language hint (ISO 639-1), so Bangla speech is read as Bangla. */
  transcriptionModel: string;
  transcriptionLanguage: string;
  /** How long the secret may be used to open the call. */
  expiresAfterSec: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface RealtimeSecret {
  value: string;
  /** Unix seconds. */
  expiresAt: number;
  model: string;
  /** SDP exchange endpoint for the WebRTC call. */
  callsUrl: string;
}

/** One MPEG-1 Layer III frame of silence (128 kbps, 44.1 kHz): a valid, tiny MP3 for dev and tests. */
export const SILENT_MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);

/** Back-compat shape used by the scan processor. */
export type MealScanRequest = Omit<StructuredRequest, 'task'> & { imageUrl: string };

export const JSON_SCHEMAS: Record<AiTask, Record<string, unknown>> = {
  meal_scan: z.toJSONSchema(MealAnalysisOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
  meal_parse: z.toJSONSchema(MealParseOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
  onboarding_extract: {}, // filled from the prompt file (content/prompts/onboarding-extract.v1.md) at runtime
  plan_narrative: planNarrativeJsonSchema(),
};

/** Strict structured-output schema for the plan narrative; also copied into content/prompts/plan-narrative.v1.md (a test keeps them equal). */
export function planNarrativeJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PlanNarrativeOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Every model call goes through this interface (plan 8.1); tests and local runs use the fake. */
export abstract class AiProvider {
  abstract readonly name: string;
  /** False when no real model is behind this provider. Features then say so instead of showing made-up output. */
  abstract readonly configured: boolean;
  abstract structured(req: StructuredRequest, schema?: Record<string, unknown>): Promise<AiResult>;
  /** Streams text deltas; resolves usage at the end (coach, plan 8.6). */
  abstract streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<AiResult>;

  /** Coach inputs pass moderation first (plan 8.8 rule 6). */
  abstract moderate(text: string, model: string): Promise<ModerationResult>;
  abstract speech(req: SpeechRequest): Promise<{ audio: Buffer; model: string }>;
  /** Realtime voice: mints the short-lived secret the app uses to talk to the model directly over WebRTC. */
  abstract realtimeSecret(req: RealtimeSecretRequest): Promise<RealtimeSecret>;

  /** Non-streaming text (rolling summaries). */
  async complete(req: ChatRequest): Promise<AiResult> {
    return this.streamChat(req, () => undefined);
  }

  analyseMeal(req: MealScanRequest): Promise<AiResult> {
    return this.structured({ ...req, task: 'meal_scan' });
  }
}

export const PARSE_EXAMPLE = {
  mealName: 'Scrambled eggs on toast',
  items: [
    { name: 'Scrambled eggs', portion: '2 eggs', grams: 120, kcal: 180, proteinG: 12.5, carbsG: 1.5, fatG: 13.5, fiberG: 0, confidence: 0.8 },
    { name: 'Wholemeal toast', portion: '1 slice', grams: 36, kcal: 86, proteinG: 3.6, carbsG: 15, fatG: 1, fiberG: 2.2, confidence: 0.8 },
  ],
  notes: 'Assumed eggs scrambled with a splash of milk.',
  clarifyingQuestion: null,
};

/** Small rule-based stand-in for onboarding extraction so local voice/typing demos work without OpenAI. */
export function fakeExtract(context: string): unknown {
  const reply = /User reply:\s*"""\s*([\s\S]*?)\s*"""/.exec(context)?.[1] ?? '';
  const open = /Open questions[^`]*```text\s*([\s\S]*?)```/.exec(context)?.[1] ?? '[]';
  let ids: string[] = [];
  try {
    ids = (JSON.parse(open) as { id: string }[]).map((q) => q.id);
  } catch {
    ids = [];
  }
  const t = reply.toLowerCase();
  const answers: { questionId: string; value: unknown; confidence: number }[] = [];
  const add = (questionId: string, value: unknown, confidence = 0.9) => ids.includes(questionId) && answers.push({ questionId, value, confidence });
  const name = /(?:[Ii]'m|[Ii] am|[Cc]all me|[Mm]y name is)\s+([A-Z][a-z]{1,30})\b/.exec(reply)?.[1];
  if (name) add('q05', name);
  for (const [word, id] of [['lose', 'lose'], ['gain', 'gain'], ['maintain', 'maintain'], ['habit', 'habits'], ['healthier', 'habits']] as const) {
    if (t.includes(word)) {
      add('q01', id);
      break;
    }
  }
  const age = /\b(?:i'm|i am|aged?)\s*(\d{2})\b/.exec(t)?.[1];
  if (age) add('q06', { kind: 'age', mode: 'age', age: Number(age), dob: null });
  const cm = /(\d{2,3})\s*(?:cm|centimet)/.exec(t)?.[1];
  if (cm) add('q08', { kind: 'height', unit: 'cm', value: Number(cm), feet: null, inches: null });
  const kg = /(\d{2,3}(?:\.\d)?)\s*(?:kg|kilo)/.exec(t)?.[1];
  if (kg) add('q09', { kind: 'weight', unit: 'kg', value: Number(kg), stone: null, pounds: null, isEstimate: /about|around|roughly|ish/.test(t) });
  return { answers, ack: answers.length ? 'Thanks, noted.' : 'Thanks.', clarify: null, userQuestion: null };
}

/** Deterministic provider for dev and tests. `enqueue` overrides the next responses (an Error is thrown). */
export const FAKE_AI_MODES = ['ok', 'not_food', 'fail', 'slow', 'unavailable'] as const;
export type FakeAiMode = (typeof FAKE_AI_MODES)[number];

/** A valid narrative for tests that switch the fake on without queueing their own answer. */
export const PLAN_NARRATIVE_EXAMPLE = {
  headline: 'A steady start that fits your week',
  summary: 'Your plan keeps meals regular and simple so it fits around your routine. The numbers are a starting point that you can adjust as you learn what works for you.',
  assumptions: ['We assumed your usual week looks like the one you described.', 'We assumed you cook some meals at home and can plan ahead a little.'],
  guidance: [
    { title: 'Anchor your meals', body: 'Pick a regular time for your main meals so hunger is easier to read and decisions get simpler.', area: 'meals' },
    { title: 'Plan one busy-day fallback', body: 'Keep one easy meal ready for the days when time runs short, so a busy day does not undo the week.', area: 'routine' },
    { title: 'Drink water with meals', body: 'Having a glass of water with each meal is an easy way to build the habit without extra effort.', area: 'hydration' },
  ],
  watchOuts: ['If you feel dizzy, very tired or unwell, speak to a health professional.'],
};

export class FakeAiProvider extends AiProvider {
  readonly name = 'fake';
  /** Tests switch this on (with `enqueue`) to exercise plan personalisation; dev servers leave it off. */
  configured = false;
  /** Dev/QA switch (POST /v1/dev/ai-mode). `unavailable` is enforced by AiService as a kill switch. */
  mode: FakeAiMode = 'ok';
  slowMs = 20_000;
  readonly calls: StructuredRequest[] = [];
  readonly chatCalls: ChatRequest[] = [];
  private queue: Array<unknown | Error> = [];

  enqueue(...responses: Array<unknown | Error>): void {
    this.queue.push(...responses);
  }

  reset(): void {
    this.configured = false;
    this.mode = 'ok';
    this.queue = [];
    this.calls.length = 0;
    this.chatCalls.length = 0;
    this.speechCalls.length = 0;
    this.realtimeCalls.length = 0;
  }

  private next(fallback: () => unknown): unknown {
    const n = this.queue.length ? this.queue.shift() : fallback();
    if (n instanceof Error) throw n;
    return n;
  }

  private async applyMode(): Promise<void> {
    if (this.mode === 'fail') throw Object.assign(new Error('fake provider failure'), { status: 500 });
    if (this.mode === 'slow') await new Promise((r) => setTimeout(r, this.slowMs));
  }

  async structured(req: StructuredRequest): Promise<AiResult> {
    this.calls.push(req);
    await this.applyMode();
    if (this.mode === 'not_food') {
      const output = {
        meal_scan: { isFood: false, mealName: '', items: [], notes: "That doesn't look like food.", clarifyingQuestion: null },
        meal_parse: { mealName: '', items: [], notes: null, clarifyingQuestion: 'What did you eat?' },
        onboarding_extract: { answers: [], ack: 'Sorry, I missed that.', clarify: 'Could you say that another way?', userQuestion: null },
        plan_narrative: structuredClone(PLAN_NARRATIVE_EXAMPLE),
      }[req.task];
      return { output, usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 900 }, model: req.model };
    }
    const fallback = {
      meal_scan: () => structuredClone(PLAN_EXAMPLE_ANALYSIS),
      meal_parse: () => structuredClone(PARSE_EXAMPLE),
      onboarding_extract: () => fakeExtract(req.context),
      plan_narrative: () => structuredClone(PLAN_NARRATIVE_EXAMPLE),
    }[req.task];
    return { output: this.next(fallback), usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 1000 }, model: req.model };
  }

  readonly speechCalls: SpeechRequest[] = [];
  readonly realtimeCalls: RealtimeSecretRequest[] = [];

  async realtimeSecret(req: RealtimeSecretRequest): Promise<RealtimeSecret> {
    this.realtimeCalls.push(req);
    await this.applyMode();
    return { value: 'ek_fake_secret', expiresAt: Math.floor(Date.now() / 1000) + req.expiresAfterSec, model: req.model, callsUrl: 'https://realtime.fake.test/v1/realtime/calls' };
  }

  /** Flags a few unambiguous phrases so tests and local runs can exercise the refusal paths. */
  async moderate(text: string): Promise<ModerationResult> {
    await this.applyMode();
    const t = text.toLowerCase();
    if (/\b(hurt myself|kill myself|end my life|self[- ]harm)\b/.test(t)) return { flagged: true, categories: ['self-harm'] };
    if (/\b(build a bomb|kill (him|her|them))\b/.test(t)) return { flagged: true, categories: ['violence'] };
    return { flagged: false, categories: [] };
  }

  async speech(req: SpeechRequest): Promise<{ audio: Buffer; model: string }> {
    this.speechCalls.push(req);
    await this.applyMode();
    return { audio: SILENT_MP3, model: req.model };
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<AiResult> {
    this.chatCalls.push(req);
    await this.applyMode();
    // Quick-action rephrasing: echo the template, as the real model is told to keep it intact.
    const last = req.messages.at(-1)?.content ?? '';
    const action = /Quick action \(null for free chat\): (\w+)/.exec(last)?.[1];
    const template = /Template text \(quick actions only\): (.*)/.exec(last)?.[1]?.trim();
    const echo = (action === 'explain_macros' || action === 'review_day') && template ? template : null;
    const text = String(this.next(() => echo ?? "Here's a gentle idea: a yoghurt with some fruit is a nice snack. Enjoy your day!"));
    for (const word of text.split(/(?<= )/)) onDelta(word);
    return { output: text, usage: { inputTokens: 800, outputTokens: 40, cachedTokens: 600 }, model: req.model };
  }
}

const REALTIME_BASE = 'https://api.openai.com/v1/realtime';

/** OpenAI Responses API with Structured Outputs (DEC-06) and Realtime client secrets. Never called in tests. */
export class OpenAiProvider extends AiProvider {
  readonly name = 'openai';
  readonly configured = true;
  private readonly client: OpenAI;

  constructor(private readonly apiKey: string) {
    super();
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async structured(req: StructuredRequest, schema?: Record<string, unknown>): Promise<AiResult> {
    const content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> = [
      { type: 'input_text', text: req.context },
    ];
    if (req.imageUrl) content.push({ type: 'input_image', image_url: req.imageUrl, detail: 'auto' });
    const res = await this.client.responses.create(
      {
        model: req.model,
        instructions: req.instructions,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name: req.task, strict: true, schema: schema ?? JSON_SCHEMAS[req.task] } },
        max_output_tokens: req.maxOutputTokens,
        ...(req.store === false ? { store: false } : {}),
        ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
      },
      { timeout: req.timeoutMs },
    );
    if (res.status === 'incomplete') throw Object.assign(new Error(`OpenAI response incomplete: ${res.incomplete_details?.reason ?? 'unknown'}`), { status: 502 });
    if (!res.output_text) throw Object.assign(new Error('OpenAI returned no text (refusal or failed response)'), { status: 422 });
    return { output: JSON.parse(res.output_text), usage: usageOf(res.usage), model: res.model };
  }

  async moderate(text: string, model: string): Promise<ModerationResult> {
    const res = await this.client.moderations.create({ model, input: text });
    const r = res.results[0];
    return { flagged: Boolean(r?.flagged), categories: Object.entries(r?.categories ?? {}).filter(([, v]) => v).map(([k]) => k) };
  }

  async speech(req: SpeechRequest): Promise<{ audio: Buffer; model: string }> {
    const res = await this.client.audio.speech.create({ model: req.model, voice: req.voice as 'alloy', input: req.text, response_format: 'mp3' }, { timeout: req.timeoutMs });
    return { audio: Buffer.from(await res.arrayBuffer()), model: req.model };
  }

  /**
   * POST /v1/realtime/client_secrets. The secret carries the whole session (instructions, tools, voice,
   * turn detection), so the app cannot change the persona or the tools. The OpenAI key never leaves the server.
   */
  async realtimeSecret(req: RealtimeSecretRequest): Promise<RealtimeSecret> {
    const res = await fetch(`${REALTIME_BASE}/client_secrets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(req.timeoutMs),
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: req.expiresAfterSec },
        session: {
          type: 'realtime',
          model: req.model,
          instructions: req.instructions,
          output_modalities: ['audio'],
          max_output_tokens: req.maxOutputTokens,
          tools: req.tools,
          tool_choice: 'auto',
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              transcription: { model: req.transcriptionModel, language: req.transcriptionLanguage },
              // The model waits until the sentence is finished: people pause mid-answer when they think of a number.
              turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true },
            },
            output: { voice: req.voice },
          },
        },
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`OpenAI client secret failed: HTTP ${res.status}`), { status: res.status >= 500 ? 502 : res.status });
    const body = (await res.json()) as { value?: string; expires_at?: number; session?: { model?: string } };
    if (!body.value) throw Object.assign(new Error('OpenAI returned no client secret'), { status: 502 });
    return { value: body.value, expiresAt: body.expires_at ?? Math.floor(Date.now() / 1000) + req.expiresAfterSec, model: body.session?.model ?? req.model, callsUrl: `${REALTIME_BASE}/calls` };
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<AiResult> {
    const stream = await this.client.responses.create(
      { model: req.model, instructions: req.instructions, input: req.messages, max_output_tokens: req.maxOutputTokens, stream: true },
      { timeout: req.timeoutMs },
    );
    let text = '';
    let usage: AiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let model = req.model;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        text += event.delta;
        onDelta(event.delta);
      } else if (event.type === 'response.completed') {
        usage = usageOf(event.response.usage);
        model = event.response.model;
      }
    }
    return { output: text, usage, model };
  }
}

function usageOf(u: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null | undefined): AiUsage {
  return { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0 };
}
