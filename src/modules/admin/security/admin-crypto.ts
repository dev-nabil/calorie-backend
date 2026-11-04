import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Admin credentials (M7-T1 / plan section 14). Passwords use scrypt (N=2^15, r=8, p=1) from
 * node:crypto; the plan names argon2id, which needs a native module (proposal: keep scrypt,
 * decision note in the handoff). TOTP follows RFC 6238 (SHA-1, 30 s, 6 digits, ±1 step).
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Decision 0005: `scrypt$N=32768,r=8,p=1$<salt>$<hash>` — algorithm and params travel with the hash. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parseParams(s: string): { N: number; r: number; p: number } | null {
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(s);
  return m ? { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) } : null;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return false;
  // Legacy 3-part form (round 2) used the default params.
  const [params, salt, hash] = parts.length === 4 ? [parseParams(parts[1]!), parts[2], parts[3]] : [{ N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, parts[1], parts[2]];
  if (!params || !salt || !hash || params.N > 1 << 20) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

/** True when a stored hash uses weaker params than today's defaults (rehash on next sign-in). */
export function needsRehash(stored: string): boolean {
  const p = stored.split('$')[1] ?? '';
  const params = parseParams(p);
  return !params || params.N < SCRYPT.N || params.r < SCRYPT.r || params.p < SCRYPT.p;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secretB32: string, at = Date.now(), digits = 6): string {
  return hotp(base32Decode(secretB32), Math.floor(at / 1000 / 30), digits);
}

/** The matching 30 s step (±1), or null. Callers store it to refuse reuse of a code (QA B11). */
export function totpStep(secretB32: string, code: string, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(at / 1000 / 30);
  for (const d of [-1, 0, 1]) if (timingSafeEqual(Buffer.from(hotp(secret, step + d)), Buffer.from(code))) return step + d;
  return null;
}

export function verifyTotp(secretB32: string, code: string, at = Date.now()): boolean {
  return totpStep(secretB32, code, at) !== null;
}

export function otpauthUrl(email: string, secretB32: string): string {
  return `otpauth://totp/Nouri%20Admin:${encodeURIComponent(email)}?secret=${secretB32}&issuer=Nouri%20Admin&algorithm=SHA1&digits=6&period=30`;
}

/** AES-256-GCM for the stored TOTP secret (totpSecretEnc). */
function key(material: string): Buffer {
  return createHash('sha256').update(`admin-totp:${material}`).digest();
}

export function encryptSecret(plain: string, material: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(material), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(blob: string, material: string): string {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(material), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
}
