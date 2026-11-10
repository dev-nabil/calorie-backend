import { z } from 'zod';
import { FridgeChefOutputSchema, LabelScanOutputSchema, MealAnalysisOutputSchema, MealParseOutputSchema, PlanNarrativeOutputSchema, WeeklyRecapOutputSchema } from '../../shared';
import { LABEL_EXAMPLE, PLAN_EXAMPLE_ANALYSIS } from '../../domain/nutrition-validator/fixtures';
import { SILENT_WAV } from './providers/wav';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type AiTask = 'meal_scan' | 'label_scan' | 'meal_parse' | 'onboarding_extract' | 'plan_narrative' | 'weekly_recap' | 'fridge_chef';

/** How much a thinking model may think before it answers. Thinking tokens bill as output and count against `maxOutputTokens`. */
export type ThinkingEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface StructuredRequest {
  task: AiTask;
  model: string;
  /** Static prefix first so Gemini's implicit prompt caching applies (S-18). */
  instructions: string;
  context: string;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Default `minimal`: extraction and short writing tasks do not need much thinking. */
  thinking?: ThinkingEffort;
  /** One photo sent with the context (fridge chef). Already re-encoded: orientation applied, metadata dropped, edge capped. */
  image?: { bytes: Buffer; mimeType: 'image/jpeg'; resolution?: 'low' | 'medium' | 'high' };
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

/** A function the live model may call. `parameters` is a JSON Schema. */
export interface RealtimeToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What the server locks into the ephemeral token of a Gemini Live session. The app cannot change any of it. */
export interface RealtimeSecretRequest {
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeToolDeclaration[];
  /** How long the token may be used to open the call. */
  expiresAfterSec: number;
  /** How long the opened session may run before Google closes it. */
  sessionSec: number;
  maxOutputTokens: number;
  /** The user's turn ends after this much silence; speaking again inside it restarts the count. */
  silenceMs: number;
  timeoutMs: number;
}

export interface RealtimeSecret {
  /** The ephemeral token (`auth_tokens/...`). The app sends it as `access_token` when it opens the WebSocket. */
  value: string;
  /** Unix seconds: the app must open the session before this. */
  expiresAt: number;
  model: string;
  /** WebSocket endpoint of the Live API for ephemeral tokens (the app appends `?access_token=<value>`). */
  callsUrl: string;
}

export interface SpeechResult {
  audio: Buffer;
  model: string;
  /** MIME type of `audio` (Gemini TTS is wrapped as WAV). */
  contentType: string;
}

export const JSON_SCHEMAS: Record<AiTask, Record<string, unknown>> = {
  meal_scan: z.toJSONSchema(MealAnalysisOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
  label_scan: z.toJSONSchema(LabelScanOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
  meal_parse: z.toJSONSchema(MealParseOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
  onboarding_extract: {}, // filled from the prompt file (content/prompts/onboarding-extract.v1.md) at runtime
  plan_narrative: planNarrativeJsonSchema(),
  weekly_recap: z.toJSONSchema(WeeklyRecapOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
  fridge_chef: z.toJSONSchema(FridgeChefOutputSchema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
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
  abstract speech(req: SpeechRequest): Promise<SpeechResult>;
  /** Realtime voice: mints the short-lived token the app uses to talk to the model directly over a WebSocket. */
  abstract realtimeSecret(req: RealtimeSecretRequest): Promise<RealtimeSecret>;

  /** Non-streaming text (rolling summaries). */
  async complete(req: ChatRequest): Promise<AiResult> {
    return this.streamChat(req, () => undefined);
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

/** Small rule-based stand-in for onboarding extraction so local voice/typing demos work without a model. */
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

/** Fake recap cards: no digits, so they pass the number check for any stats (tests queue their own to test it). */
export const RECAP_EXAMPLE = {
  cards: [
    { topic: 'logging', title: 'You kept showing up', text: 'You logged your meals on several days this week. That steady habit is what makes your week easy to read.', miloState: 'celebrating' },
    { topic: 'meals', title: 'Meals on the map', text: 'Every meal you logged adds a little more to the story of your week.', miloState: 'speaking' },
    { topic: 'water', title: 'Sips add up', text: 'You kept water in the mix this week. Small sips count.', miloState: 'speaking' },
    { topic: 'next_week', title: 'One idea for next week', text: 'Try logging breakfast before the day gets busy. It is a quick win to start with.', miloState: 'thinking' },
  ],
};

export const FRIDGE_EXAMPLE = {
  notFood: false,
  ingredients: ['Eggs', 'Spinach', 'Tomatoes', 'Cheddar', 'Bread'],
  ideas: [
    {
      name: 'Spinach and tomato omelette',
      why: 'Quick, warm and uses what you already have.',
      minutes: 10,
      kcal: 320,
      uses: ['Eggs', 'Spinach', 'Tomatoes', 'Cheddar'],
      extra: ['Oil', 'Salt and pepper'],
      steps: ['Beat the eggs with a pinch of salt.', 'Wilt the spinach in a little oil.', 'Pour in the eggs and add the tomatoes.', 'Top with cheddar, fold and serve.'],
    },
    {
      name: 'Cheesy tomato toast',
      why: 'A five-minute snack or light lunch.',
      minutes: 5,
      kcal: 280,
      uses: ['Bread', 'Tomatoes', 'Cheddar'],
      extra: ['Black pepper'],
      steps: ['Toast the bread.', 'Add sliced tomatoes and cheddar.', 'Grill until the cheese melts.'],
    },
  ],
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
        meal_scan: { status: 'no_food', box_2d: null, mealName: null, items: [], assumptions: [], question: "That doesn't look like food.", retake: null },
        label_scan: { ...structuredClone(LABEL_EXAMPLE), status: 'no_food', name: null, en: null, rich: [], question: 'I cannot see a nutrition table.' },
        meal_parse: { mealName: '', items: [], notes: null, clarifyingQuestion: 'What did you eat?' },
        onboarding_extract: { answers: [], ack: 'Sorry, I missed that.', clarify: 'Could you say that another way?', userQuestion: null },
        plan_narrative: structuredClone(PLAN_NARRATIVE_EXAMPLE),
        weekly_recap: structuredClone(RECAP_EXAMPLE),
        fridge_chef: { notFood: true, ingredients: [], ideas: [] },
      }[req.task];
      return { output, usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 900 }, model: req.model };
    }
    const fallback = {
      meal_scan: () => structuredClone(PLAN_EXAMPLE_ANALYSIS),
      label_scan: () => structuredClone(LABEL_EXAMPLE),
      meal_parse: () => structuredClone(PARSE_EXAMPLE),
      onboarding_extract: () => fakeExtract(req.context),
      plan_narrative: () => structuredClone(PLAN_NARRATIVE_EXAMPLE),
      weekly_recap: () => structuredClone(RECAP_EXAMPLE),
      fridge_chef: () => structuredClone(FRIDGE_EXAMPLE),
    }[req.task];
    return { output: this.next(fallback), usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 1000 }, model: req.model };
  }

  readonly speechCalls: SpeechRequest[] = [];
  readonly realtimeCalls: RealtimeSecretRequest[] = [];

  async realtimeSecret(req: RealtimeSecretRequest): Promise<RealtimeSecret> {
    this.realtimeCalls.push(req);
    await this.applyMode();
    return { value: 'auth_tokens/fake_secret', expiresAt: Math.floor(Date.now() / 1000) + req.expiresAfterSec, model: req.model, callsUrl: 'wss://realtime.fake.test/ws/live' };
  }

  /** Flags a few unambiguous phrases so tests and local runs can exercise the refusal paths. */
  async moderate(text: string): Promise<ModerationResult> {
    await this.applyMode();
    const t = text.toLowerCase();
    if (/\b(hurt myself|kill myself|end my life|self[- ]harm)\b/.test(t)) return { flagged: true, categories: ['self-harm'] };
    if (/\b(build a bomb|kill (him|her|them))\b/.test(t)) return { flagged: true, categories: ['violence'] };
    return { flagged: false, categories: [] };
  }

  async speech(req: SpeechRequest): Promise<SpeechResult> {
    this.speechCalls.push(req);
    await this.applyMode();
    return { audio: SILENT_WAV, model: req.model, contentType: 'audio/wav' };
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
