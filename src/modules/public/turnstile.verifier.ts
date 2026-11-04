
/** Cloudflare Turnstile check for landing-page forms (M8-T2). */
export abstract class TurnstileVerifier {
  abstract verify(token: string, ip?: string): Promise<boolean>;
}
export class AllowTurnstileVerifier extends TurnstileVerifier {
  async verify(token: string): Promise<boolean> {
    return token.length > 0;
  }
}
export class CloudflareTurnstileVerifier extends TurnstileVerifier {
  constructor(private readonly secret: string) {
    super();
  }
  async verify(token: string, ip?: string): Promise<boolean> {
    const body = new URLSearchParams({ secret: this.secret, response: token, ...(ip ? { remoteip: ip } : {}) });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  }
}
