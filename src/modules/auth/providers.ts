import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { requestLocale } from '../../common/http/request-context';
import { translatorFor } from '../../shared/i18n';
import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import disposableDomains from 'disposable-email-domains/index.json';

export interface ProviderIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

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

/** Google ID-token verification (M1-T3). */
export abstract class GoogleTokenVerifier {
  abstract verify(idToken: string): Promise<ProviderIdentity>;
}

export class GoogleAuthLibraryVerifier extends GoogleTokenVerifier {
  private readonly client = new OAuth2Client();
  constructor(private readonly audiences: string[]) {
    super();
  }
  async verify(idToken: string): Promise<ProviderIdentity> {
    if (!this.audiences.length) throw new Error('GOOGLE_CLIENT_IDS not configured');
    const ticket = await this.client.verifyIdToken({ idToken, audience: this.audiences });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error('no subject');
    return { subject: p.sub, email: p.email?.toLowerCase() ?? null, emailVerified: p.email_verified === true, name: p.name ?? null };
  }
}

/** Apple identity-token verification against Apple's JWKS (M1-T3). */
export abstract class AppleTokenVerifier {
  abstract verify(identityToken: string, rawNonce?: string): Promise<ProviderIdentity>;
}

export const APPLE_ISSUER = 'https://appleid.apple.com';

export class JoseAppleVerifier extends AppleTokenVerifier {
  constructor(
    private readonly audiences: string[],
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`)),
  ) {
    super();
  }
  async verify(identityToken: string, rawNonce?: string): Promise<ProviderIdentity> {
    if (!this.audiences.length) throw new Error('APPLE_BUNDLE_ID / APPLE_SERVICE_ID not configured');
    const { payload } = await jwtVerify(identityToken, this.keys, { issuer: APPLE_ISSUER, audience: this.audiences });
    if (!payload.sub) throw new Error('no subject');
    if (rawNonce !== undefined) {
      const expected = createHash('sha256').update(rawNonce).digest('hex');
      if (payload.nonce !== expected && payload.nonce !== rawNonce) throw new Error('nonce mismatch');
    }
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    return { subject: payload.sub, email, emailVerified: verified, name: null };
  }
}

const DISPOSABLE = new Set<string>(disposableDomains);

/** S-03: disposable domains are rejected at sign-up. Subdomains of a listed domain count too. */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  return false;
}
