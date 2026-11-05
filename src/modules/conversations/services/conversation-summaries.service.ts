import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlers } from '../../../jobs/jobs.module';
import { AiProvider } from '../../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../../ai/ai-models';
import { AiService } from '../../ai/ai.service';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import type { ConversationDoc, MessageDoc } from '../schemas/conversations.schema';

export const SUMMARY_JOB = 'conversation_summary';
export const SUMMARY_EVERY = 20; // plan 8.6: rolling summary every 20 messages

/** Worker job: folds older messages into conversations.summary (sent with every coach turn). */
@Injectable()
export class ConversationSummaries implements OnModuleInit {
  constructor(
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly handlers: JobHandlers,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
  ) {}

  onModuleInit(): void {
    this.handlers.register(SUMMARY_JOB, (p) => this.summarise((p as { conversationId: string }).conversationId));
  }

  async summarise(conversationId: string): Promise<string> {
    const conv = await this.conversations.findById(conversationId).lean<ConversationDoc>();
    if (!conv) return '';
    const recent = (await this.messages.find({ conversationId: conv._id }).sort({ createdAt: -1 }).limit(SUMMARY_EVERY * 2).lean<MessageDoc[]>()).reverse();
    const transcript = recent.map((m) => `${m.role === 'user' ? 'User' : 'Milo'}: ${m.text}`).join('\n');
    const model = await this.ai.modelFor('chat', DEFAULT_TEXT_MODEL);
    const res = await this.ai.runOrUnavailable('chat', () =>
      this.provider.complete({
        model,
        instructions: 'Summarise this nutrition-coach conversation in at most 5 short bullet points: goals, preferences, open questions and anything the user asked Milo to remember. No health judgements. Plain UK English.',
        messages: [{ role: 'user', content: `Earlier summary:\n${conv.summary || 'None'}\n\nLatest messages:\n${transcript}` }],
        timeoutMs: 15_000,
        maxOutputTokens: 200,
      }),
    );
    const summary = String(res.output).slice(0, 2000);
    await this.conversations.updateOne({ _id: conv._id }, { $set: { summary } });
    return summary;
  }
}
