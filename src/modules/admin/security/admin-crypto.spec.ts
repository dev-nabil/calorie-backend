import { needsRehash, base32Decode, base32Encode, decryptSecret, encryptSecret, hashPassword, hotp, otpauthUrl, totp, verifyPassword, verifyTotp } from './admin-crypto';

describe('admin crypto (M7-T1)', () => {
  it('hashes and verifies passwords with scrypt', () => {
    const h = hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$N=32768,r=8,p=1$')).toBe(true);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash('scrypt$N=1024,r=8,p=1$a$b')).toBe(true);
    const [, , salt, hash] = h.split('$');
    expect(verifyPassword('correct horse battery staple', `scrypt$${salt}$${hash}`)).toBe(true); // legacy form
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(verifyPassword('x', 'md5$a$b')).toBe(false);
  });

  it('matches the RFC 4226 / 6238 test vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 9)).toBe('520489');
    const b32 = base32Encode(secret);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    expect(totp(b32, 59_000, 8)).toBe('94287082');
    expect(totp(b32, 1111111109_000, 8)).toBe('07081804');
  });

  it('accepts codes one step either side only', () => {
    const b32 = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_800_000_000_000;
    expect(verifyTotp(b32, totp(b32, now), now)).toBe(true);
    expect(verifyTotp(b32, totp(b32, now - 30_000), now)).toBe(true);
    expect(verifyTotp(b32, totp(b32, now - 90_000), now)).toBe(false);
    expect(verifyTotp(b32, 'abcdef', now)).toBe(false);
    expect(() => base32Decode('!!')).toThrow();
    expect(otpauthUrl('a@b.c', b32)).toContain('secret=' + b32);
  });

  it('encrypts the TOTP secret with AES-GCM', () => {
    const blob = encryptSecret('SECRET', 'k');
    expect(decryptSecret(blob, 'k')).toBe('SECRET');
    expect(() => decryptSecret(blob, 'other')).toThrow();
  });
});
