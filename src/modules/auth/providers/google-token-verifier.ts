import { OAuth2Client } from 'google-auth-library';
import { resolveLive, type Live, type ProviderIdentity } from './provider-identity';

/** Google ID-token verification (M1-T3). */
export abstract class GoogleTokenVerifier {
  abstract verify(idToken: string): Promise<ProviderIdentity>;
}

export class GoogleAuthLibraryVerifier extends GoogleTokenVerifier {
  private readonly client = new OAuth2Client();
  constructor(private readonly audiences: Live<string[]>) {
    super();
  }
  async verify(idToken: string): Promise<ProviderIdentity> {
    const audience = await resolveLive(this.audiences);
    if (!audience.length) throw new Error('Google sign-in is not configured (setting auth.google.clientIds)');
    const ticket = await this.client.verifyIdToken({ idToken, audience });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error('no subject');
    return { subject: p.sub, email: p.email?.toLowerCase() ?? null, emailVerified: p.email_verified === true, name: p.name ?? null };
  }
}
