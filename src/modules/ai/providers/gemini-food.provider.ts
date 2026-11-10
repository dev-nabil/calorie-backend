import { z } from 'zod';
import { LabelScanOutputSchema, MealAnalysisOutputSchema, type ScanMode } from '../../../shared';
import { toGeminiSchema } from '../gemini-schema';
import { FoodVisionError, FoodVisionProvider, type FoodVisionRequest, type FoodVisionResult } from './food-vision.provider';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

type JsonSchema = Record<string, unknown>;

/** The response schema sent to Gemini, generated from the same zod schema that validates the reply. */
export function foodScanResponseSchema(mode: ScanMode = 'meal'): JsonSchema {
  const schema = mode === 'label' ? LabelScanOutputSchema : MealAnalysisOutputSchema;
  return toGeminiSchema(z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as JsonSchema);
}

const RESPONSE_SCHEMAS: Record<ScanMode, JsonSchema> = { meal: foodScanResponseSchema('meal'), label: foodScanResponseSchema('label') };

/** Gemini 2.5 has neither the thinking levels nor per-image resolution, and thinking is off there by default. */
const hasGemini3Controls = (model: string): boolean => !model.startsWith('gemini-2.');

interface InteractionResponse {
  status?: string;
  model?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { total_input_tokens?: number; total_cached_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
}

function outputText(body: InteractionResponse): string {
  return (body.steps ?? [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Gemini Interactions API. `store: false` keeps the photo out of Google's 55-day interaction store.
 * The key travels in a header, never in the URL, and nothing here logs the request.
 */
export class GeminiFoodProvider extends FoodVisionProvider {
  readonly name = 'gemini';
  readonly configured = true;

  constructor(private readonly apiKey: string) {
    super();
  }

  async analyse(req: FoodVisionRequest): Promise<FoodVisionResult> {
    const modern = hasGemini3Controls(req.model);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json', 'Api-Revision': API_REVISION },
        signal: AbortSignal.timeout(req.timeoutMs),
        body: JSON.stringify({
          model: req.model,
          store: false,
          system_instruction: req.instructions,
          input: [
            { type: 'text', text: req.context },
            { type: 'image', data: req.image.bytes.toString('base64'), mime_type: req.image.mimeType, ...(modern ? { resolution: req.resolution } : {}) },
          ],
          generation_config: { max_output_tokens: req.maxOutputTokens, ...(modern ? { thinking_level: req.thinkingLevel } : {}) },
          response_format: { type: 'text', mime_type: 'application/json', schema: RESPONSE_SCHEMAS[req.mode ?? 'meal'] },
        }),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new FoodVisionError('Gemini timed out', 'timeout');
      throw new FoodVisionError(`Gemini unreachable (${name})`, 'transient');
    }
    if (!res.ok) throw new FoodVisionError(`Gemini HTTP ${res.status}`, TRANSIENT_STATUS.has(res.status) ? 'transient' : 'permanent', res.status, retryAfterMs(res));
    const body = (await res.json().catch(() => ({}))) as InteractionResponse;
    if (body.status !== 'completed' && body.status !== 'incomplete') throw new FoodVisionError(`Gemini status ${body.status ?? 'missing'}`, 'permanent', res.status);
    return {
      output: parseJson(outputText(body)),
      truncated: body.status === 'incomplete',
      usage: {
        inputTokens: body.usage?.total_input_tokens ?? 0,
        cachedTokens: body.usage?.total_cached_tokens ?? 0,
        outputTokens: body.usage?.total_output_tokens ?? 0,
        thoughtTokens: body.usage?.total_thought_tokens ?? 0,
      },
      model: body.model ?? req.model,
    };
  }
}
