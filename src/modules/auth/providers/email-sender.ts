import { Logger } from '@nestjs/common';
import { requestLocale } from '../../../common/http/request-context';
import { translatorFor } from '../../../shared/i18n';

/** Sends the sign-in code. Production uses Resend (OQ-09); dev prints to the console. */
export abstract class EmailSender {
  abstract sendOtp(email: string, code: string): Promise<void>;
  /** GET /me/export: link to the JSON file (signed, 24 h). */
  abstract sendLink(email: string, kind: 'export' | 'admin_invite', url: string): Promise<void>;
}

/** Test driver: keeps the last code per address. */
export class MemoryEmailSender extends EmailSender {
  readonly outbox = new Map<string, string>();
  readonly links = new Map<string, { kind: string; url: string }>();
  async sendOtp(email: string, code: string): Promise<void> {
    this.outbox.set(email, code);
  }
  async sendLink(email: string, kind: 'export' | 'admin_invite', url: string): Promise<void> {
    this.links.set(email, { kind, url });
  }
}

/** Development driver: prints the code and keeps it for GET /v1/dev/last-otp. Refused in production. */
export class ConsoleEmailSender extends MemoryEmailSender {
  private readonly logger = new Logger('DevEmail');
  override async sendOtp(email: string, code: string): Promise<void> {
    await super.sendOtp(email, code);
    this.logger.warn(`\n\n  ==== SIGN-IN CODE for ${email}: ${code} ====\n`);
  }
  override async sendLink(email: string, kind: 'export' | 'admin_invite', url: string): Promise<void> {
    await super.sendLink(email, kind, url);
    this.logger.warn(`[dev email] ${kind} link for ${email}: ${url}`);
  }
}

export class ResendEmailSender extends EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }
  async sendOtp(email: string, code: string): Promise<void> {
    const tr = translatorFor(requestLocale()); // sign-in is a live request: use the language the app is in
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [email],
        subject: tr('email.otp.subject', { code }),
        text: tr('email.otp.body', { code }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`email provider returned ${res.status}`);
  }
  async sendLink(email: string, kind: 'export' | 'admin_invite', url: string): Promise<void> {
    const subject = kind === 'export' ? 'Your Nouri data export is ready' : 'You have been invited to the Nouri admin panel';
    const text = kind === 'export' ? `Download your data (link valid for 24 hours): ${url}` : `Set up your admin account (link valid for 72 hours): ${url}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [email], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`email provider returned ${res.status}`);
  }
}
