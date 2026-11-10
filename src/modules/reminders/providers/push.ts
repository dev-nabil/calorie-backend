import { Logger } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/** DEC-12 push; the reminders job sends in batches of up to 500 (M9-T1). Returns tokens FCM rejected as unregistered. */
export abstract class PushSender {
  abstract sendBatch(messages: PushMessage[]): Promise<{ sent: number; invalidTokens: string[] }>;
}

/** Development driver: logs and keeps the messages for tests. */
export class ConsolePushSender extends PushSender {
  private readonly logger = new Logger('DevPush');
  readonly sent: PushMessage[] = [];
  async sendBatch(messages: PushMessage[]): Promise<{ sent: number; invalidTokens: string[] }> {
    this.sent.push(...messages);
    for (const m of messages) this.logger.log(`[dev push] ${m.title}: ${m.body}`);
    return { sent: messages.length, invalidTokens: [] };
  }
}

/** FCM HTTP v1 with the Firebase service account (FIREBASE_SERVICE_ACCOUNT_JSON). */
export class FcmPushSender extends PushSender {
  private readonly auth: GoogleAuth;
  private readonly projectId: string;
  constructor(serviceAccountJson: string) {
    super();
    const creds = JSON.parse(serviceAccountJson) as { project_id: string };
    this.projectId = creds.project_id;
    this.auth = new GoogleAuth({ credentials: creds as never, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  }
  async sendBatch(messages: PushMessage[]): Promise<{ sent: number; invalidTokens: string[] }> {
    const client = await this.auth.getClient();
    const invalid: string[] = [];
    let sent = 0;
    for (let i = 0; i < messages.length; i += 50) {
      await Promise.all(
        messages.slice(i, i + 50).map(async (m) => {
          try {
            await client.request({
              url: `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
              method: 'POST',
              data: { message: { token: m.token, notification: { title: m.title, body: m.body }, data: m.data } },
              timeout: 10_000,
            });
            sent++;
          } catch (e) {
            const status = (e as { response?: { status?: number } }).response?.status;
            if (status === 404 || status === 400) invalid.push(m.token);
          }
        }),
      );
    }
    return { sent, invalidTokens: invalid };
  }
}
