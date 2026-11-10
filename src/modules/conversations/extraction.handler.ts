import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { ERROR_CODES, ExtractionOutputSchema, type ExtractionOutput } from '../../shared';
import { ApiError } from '../../common/errors/api-error';
import { DEFAULT_LOCALE, parseLocale } from '../../shared/locales';
import { AiJobs } from '../ai/ai-jobs';
import { languageDirective } from '../ai/language';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService } from '../ai/ai.service';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';

export const EXTRACT_JOB = 'onboarding_extract';
export const EXTRACT_TIMEOUT_MS = 15_000;

export interface ExtractJob {
  values: Record<string, string>;
}

/** The output JSON schema is defined in the prompt file itself (## Output schema). */
export function schemaFromPrompt(raw: string): Record<string, unknown> | undefined {
  const m = /## Output schema[\s\S]*?```json\s*([\s\S]*?)```/.exec(raw);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[1]!) as { schema?: Record<string, unknown> };
    return parsed.schema;
  } catch {
    return undefined;
  }
}

/** An AI job (AiJobs): one extraction call for one conversation turn (plan 8.5). */
@Injectable()
export class ExtractionHandler implements OnModuleInit {
  constructor(
    private readonly handlers: AiJobs,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(EXTRACT_JOB, (p) => this.handle(p as ExtractJob));
  }

  async handle(job: ExtractJob): Promise<ExtractionOutput> {
    const prompt = await this.content.activePrompt('onboarding-extract');
    const model = prompt?.model || (await this.ai.modelFor('extract', DEFAULT_TEXT_MODEL));
    const res = await this.ai.runOrUnavailable('extract', () =>
      this.provider.structured(
        {
          task: 'onboarding_extract',
          model,
          instructions: prompt?.staticPrefix ?? 'Extract onboarding answers. Return JSON.',
          context: languageDirective(parseLocale(job.values.locale) ?? DEFAULT_LOCALE) + fillTemplate(prompt?.dynamicTemplate ?? 'User reply:\n"""\n{{text}}\n"""', job.values),
          timeoutMs: EXTRACT_TIMEOUT_MS,
          maxOutputTokens: 400,
        },
        prompt ? schemaFromPrompt(prompt.content) : undefined,
      ),
    );
    const parsed = ExtractionOutputSchema.safeParse(res.output);
    if (!parsed.success) throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'Milo did not catch that. Try again or use the form.', HttpStatus.BAD_GATEWAY);
    return parsed.data;
  }
}
