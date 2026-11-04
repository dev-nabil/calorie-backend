import { OAuth2Client } from 'google-auth-library';
import type { ProviderIdentity } from './provider-identity';

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
