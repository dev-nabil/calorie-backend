import { createHash, createHmac } from 'node:crypto';

/** AWS Signature V4 query-string presigning for S3-compatible stores (R2, S3, MinIO). */
export interface S3Target {
  endpoint: string; // e.g. https://<account>.r2.cloudflarestorage.com
  region: string; // 'auto' for R2
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true when the endpoint host already names the bucket (virtual-hosted style). */
  virtualHosted?: boolean;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

export function presignS3(
  t: S3Target,
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  key: string,
  expiresSec: number,
  now: Date,
  signedHeaders: Record<string, string> = {},
  extraQuery: Record<string, string> = {},
): string {
  const url = new URL(t.endpoint);
  const path = (t.virtualHosted ? '' : `/${t.bucket}`) + (key ? '/' + key.split('/').map(enc).join('/') : t.virtualHosted ? '/' : '');
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${t.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(signedHeaders)) headers[k.toLowerCase()] = v.trim();
  const headerNames = Object.keys(headers).sort();
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${t.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': headerNames.join(';'),
    ...extraQuery,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k]!)}`)
    .join('&');
  const canonicalHeaders = headerNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, headerNames.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, date), t.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `${url.protocol}//${url.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
