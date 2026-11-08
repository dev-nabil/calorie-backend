import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { requestOrigin } from '../../common/http/request-context';
import { presignS3, type S3Target } from './sigv4';

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
}

/** Private object storage (DEC-08): presigned uploads, signed reads. */
export abstract class StorageService {
  abstract readonly driver: 'local' | 's3';
  abstract presignPut(key: string, contentType: string, maxBytes: number, expiresSec: number): PresignedPut;
  abstract signedGetUrl(key: string, expiresSec?: number): string;
  /** True when the object was uploaded (local driver checks the disk; S3 trusts the client for now). */
  abstract exists(key: string): Promise<boolean>;
  /** Stored size in bytes, null when missing. Read this before `get`: a presigned S3 PUT does not enforce a size. */
  abstract size(key: string): Promise<number | null>;
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  abstract get(key: string): Promise<Buffer | null>;
  /** Removes one object; a missing object is not an error. */
  abstract delete(key: string): Promise<void>;
  /** Removes every object under a prefix (account purge). */
  abstract deletePrefix(prefix: string): Promise<number>;
}

/**
 * DEC-08 delivery through the CDN with signed URLs: `${CDN_BASE_URL}/${key}?exp=…&sig=HMAC(key\nexp)`.
 * The edge (Cloudflare Worker) checks the same HMAC with CDN_SIGNING_KEY before reading the bucket.
 */
export function signCdnUrl(base: string, key: string, signingKey: string, expiresSec: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + expiresSec;
  const sig = createHmac('sha256', signingKey).update(`${key}\n${exp}`).digest('base64url');
  return `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`;
}

/** Keys are `u/<userId>/<kind>/<yyyy>/<mm>/<uuid>.<ext>`; never absolute, never `..`. */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9/_.-]{1,512}$/.test(key) && !key.includes('..') && !key.startsWith('/');
}

/** Development driver: files under LOCAL_STORAGE_DIR, PUT/GET through /v1/dev/uploads with an HMAC signature. */
export class LocalStorageService extends StorageService {
  readonly driver = 'local' as const;

  constructor(
    private readonly dir: string,
    private readonly secret: string,
    private readonly fallbackOrigin: string,
  ) {
    super();
  }

  sign(method: string, key: string, exp: number, extra = ''): string {
    return createHmac('sha256', this.secret).update(`${method}\n${key}\n${exp}\n${extra}`).digest('hex');
  }

  verify(method: string, key: string, exp: number, sig: string, extra = ''): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const a = Buffer.from(this.sign(method, key, exp, extra), 'hex');
    const b = Buffer.from(sig, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private url(method: string, key: string, expiresSec: number, extra = ''): string {
    const exp = Math.floor(Date.now() / 1000) + expiresSec;
    const qs = new URLSearchParams({ key, exp: String(exp), sig: this.sign(method, key, exp, extra) });
    return `${requestOrigin() ?? this.fallbackOrigin}/v1/dev/uploads?${qs.toString()}`;
  }

  presignPut(key: string, contentType: string, maxBytes: number, expiresSec: number): PresignedPut {
    const extra = `${contentType}\n${maxBytes}`;
    return { url: this.url('PUT', key, expiresSec, extra) + `&ct=${encodeURIComponent(contentType)}&max=${maxBytes}`, headers: { 'Content-Type': contentType } };
  }

  signedGetUrl(key: string, expiresSec = 3600): string {
    return this.url('GET', key, expiresSec);
  }

  path(key: string): string {
    const root = resolve(this.dir);
    const p = normalize(join(root, key));
    if (!p.startsWith(root + '/')) throw new Error('unsafe key');
    return p;
  }

  write(key: string, body: Buffer): void {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }

  read(key: string): Buffer | null {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : null;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return isSafeKey(key) && statSync(this.path(key)).isFile();
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      return isSafeKey(key) ? statSync(this.path(key)).size : null;
    } catch {
      return null;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.write(key, body);
  }

  async get(key: string): Promise<Buffer | null> {
    return this.read(key);
  }

  async delete(key: string): Promise<void> {
    if (isSafeKey(key)) rmSync(this.path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const p = this.path(prefix.replace(/\/$/, ''));
    if (!existsSync(p)) return 0;
    rmSync(p, { recursive: true, force: true });
    return 1;
  }
}

/** Production driver for Cloudflare R2 or S3 (path-style). Delivery through the CDN comes with M4-T8. */
export class S3StorageService extends StorageService {
  readonly driver = 's3' as const;
  constructor(
    private readonly target: S3Target,
    private readonly cdn: { base: string; key: string } | null = null,
  ) {
    super();
  }
  presignPut(key: string, contentType: string, _maxBytes: number, expiresSec: number): PresignedPut {
    return { url: presignS3(this.target, 'PUT', key, expiresSec, new Date(), { 'Content-Type': contentType }), headers: { 'Content-Type': contentType } };
  }
  signedGetUrl(key: string, expiresSec = 3600): string {
    if (this.cdn) return signCdnUrl(this.cdn.base, key, this.cdn.key, expiresSec);
    return presignS3(this.target, 'GET', key, expiresSec, new Date());
  }
  async size(key: string): Promise<number | null> {
    if (!isSafeKey(key)) return null;
    try {
      const res = await fetch(presignS3(this.target, 'HEAD', key, 60, new Date()), { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const length = Number(res.headers.get('content-length'));
      return res.ok && Number.isFinite(length) ? length : null;
    } catch {
      return null;
    }
  }
  /** Round-4 gap: a presigned HEAD confirms the client really uploaded the object before a scan is queued. */
  async exists(key: string): Promise<boolean> {
    if (!isSafeKey(key)) return false;
    try {
      const res = await fetch(presignS3(this.target, 'HEAD', key, 60, new Date()), { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await fetch(presignS3(this.target, 'PUT', key, 300, new Date(), { 'Content-Type': contentType }), { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(body) });
    if (!res.ok) throw new Error(`storage put ${res.status}`);
  }
  async get(key: string): Promise<Buffer | null> {
    const res = await fetch(presignS3(this.target, 'GET', key, 300, new Date()));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage get ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    if (!isSafeKey(key)) return;
    const res = await fetch(presignS3(this.target, 'DELETE', key, 300, new Date()), { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 404) throw new Error(`storage delete ${res.status}`);
  }
  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (let page = 0; page < 100; page++) {
      const list = await fetch(presignS3(this.target, 'GET', '', 300, new Date(), {}, { 'list-type': '2', prefix }));
      const keys = [...(await list.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
      if (!keys.length) break;
      for (const k of keys) {
        await fetch(presignS3(this.target, 'DELETE', k, 300, new Date()), { method: 'DELETE' });
        n++;
      }
    }
    return n;
  }
}
