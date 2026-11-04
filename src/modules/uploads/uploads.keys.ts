import { randomUUID } from 'node:crypto';
import { UPLOAD_KINDS } from '../../shared';

export const PRESIGN_TTL_SEC = 300; // plan section 14: presigned PUT valid for 5 minutes

/** Keys are sharded by user (plan section 15): u/<userId>/<kind>/<yyyy>/<mm>/<uuid>.<ext>. */
export function uploadKey(userId: string, kind: keyof typeof UPLOAD_KINDS, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `u/${userId}/${kind}/${yyyy}/${mm}/${randomUUID()}.${UPLOAD_KINDS[kind].ext}`;
}

export function ownsKey(userId: string, kind: keyof typeof UPLOAD_KINDS, key: string): boolean {
  return key.startsWith(`u/${userId}/${kind}/`);
}
