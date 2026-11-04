import { createHmac } from 'node:crypto';
import { signCdnUrl } from './storage';
import { presignS3 } from './sigv4';

describe('SigV4 presign', () => {
  it('matches the AWS documentation example for a presigned GET', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignS3(
      {
        endpoint: 'https://examplebucket.s3.amazonaws.com',
        region: 'us-east-1',
        bucket: 'examplebucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        virtualHosted: true,
      },
      'GET',
      'test.txt',
      86400,
      new Date('2013-05-24T00:00:00Z'),
    );
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
  });

  it('signs path-style PUTs with the content type', () => {
    const url = presignS3(
      { endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'nouri', accessKeyId: 'k', secretAccessKey: 's' },
      'PUT',
      'u/1/meal_photo/a b.jpg',
      300,
      new Date('2026-11-02T10:00:00Z'),
      { 'Content-Type': 'image/jpeg' },
    );
    expect(url).toMatch(/^https:\/\/acc\.r2\.cloudflarestorage\.com\/nouri\/u\/1\/meal_photo\/a%20b\.jpg\?/);
    expect(url).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
  });
});

describe('CDN signed URLs (DEC-08)', () => {
  it('signs key and expiry with HMAC for the edge to verify', () => {
    const url = new URL(signCdnUrl('https://cdn.example/', 'u/1/a b.jpg', 'k', 3600, 1_000_000_000_000));
    expect(url.pathname).toBe('/u/1/a%20b.jpg');
    const exp = url.searchParams.get('exp')!;
    expect(exp).toBe(String(1_000_000_000 + 3600));
    expect(url.searchParams.get('sig')).toBe(createHmac('sha256', 'k').update(`u/1/a b.jpg\n${exp}`).digest('base64url'));
  });
});

describe('S3StorageService.exists (HEAD before a scan)', () => {
  const target = { endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'nouri', accessKeyId: 'k', secretAccessKey: 's' };
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  it('sends a presigned HEAD and maps the status', async () => {
    const { S3StorageService } = await import('./storage');
    const calls: { url: string; method?: string }[] = [];
    global.fetch = (async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      return { ok: url.includes('present.jpg') } as Response;
    }) as unknown as typeof fetch;
    const s = new S3StorageService(target);
    expect(await s.exists('u/1/meal_photo/present.jpg')).toBe(true);
    expect(await s.exists('u/1/meal_photo/missing.jpg')).toBe(false);
    expect(await s.exists('../etc/passwd')).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: 'HEAD' });
    expect(calls[0]!.url).toContain('X-Amz-Signature=');
    global.fetch = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(await s.exists('u/1/meal_photo/present.jpg')).toBe(false);
  });
});
