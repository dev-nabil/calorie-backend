import type { Model } from 'mongoose';
import type { DeviceDoc } from '../../modules/users/users.schemas';
import { AppAttestVerifier } from './app-attest';
import { IntegrityVerifier, type IntegrityContext, type IntegrityResult } from './integrity';
import { evaluatePlayVerdict, requestHashFor, type PlayDecoder } from './play-integrity';

const MAX_SKEW_MS = 5 * 60_000;

/** Production integrity driver: App Attest assertions (stored keys) and Play Integrity verdicts. */
export class DeviceIntegrityVerifier extends IntegrityVerifier {
  constructor(
    private readonly devices: Model<DeviceDoc>,
    private readonly appAttest: AppAttestVerifier | null,
    private readonly play: { decode: PlayDecoder; packageName: string } | null,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async verify(token: string, ctx: IntegrityContext): Promise<IntegrityResult> {
    const ts = Number(ctx.timestamp);
    if (!ts || Math.abs(this.now() - ts) > MAX_SKEW_MS) return { valid: false, reason: 'timestamp' };
    const clientData = Buffer.from(`${ctx.method} ${ctx.path} ${ts}`);
    if (token.startsWith('appattest.') && this.appAttest) {
      const [, keyId, assertion] = token.split('.');
      if (!keyId || !assertion) return { valid: false, reason: 'format' };
      const filter: Record<string, unknown> = { 'integrity.keyId': keyId };
      if (ctx.userId) filter.userId = ctx.userId;
      const device = await this.devices.findOne(filter).lean<DeviceDoc>();
      if (!device?.integrity.publicKeyPem) return { valid: false, reason: 'unknown_key' };
      const r = this.appAttest.verifyAssertion(Buffer.from(assertion, 'base64url'), device.integrity.publicKeyPem, clientData, device.integrity.counter ?? 0);
      if (!r.valid) return { valid: false, reason: r.reason };
      const bumped = await this.devices.updateOne({ _id: device._id, 'integrity.counter': { $lt: r.counter } }, { $set: { 'integrity.counter': r.counter, 'integrity.verifiedAt': new Date() } });
      return bumped.modifiedCount === 1 ? { valid: true } : { valid: false, reason: 'replay' };
    }
    if (token.startsWith('playintegrity.') && this.play) {
      try {
        const verdict = await this.play.decode(token.slice('playintegrity.'.length));
        return evaluatePlayVerdict(verdict, { packageName: this.play.packageName, requestHash: requestHashFor(clientData), now: this.now() });
      } catch {
        return { valid: false, reason: 'decode' };
      }
    }
    return { valid: false, reason: 'format' };
  }
}
