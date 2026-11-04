/** Minimal CBOR decoder for App Attest objects (RFC 8949: ints, byte/text strings, arrays, maps, simple values). */
export type Cbor = number | bigint | Buffer | string | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

export function decodeCbor(buf: Buffer): Cbor {
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error('CBOR: truncated');
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (size < 0) throw new Error('CBOR: unsupported length');
    need(size);
    const v = size === 8 ? Number(buf.readBigUInt64BE(pos)) : buf.readUIntBE(pos, size);
    pos += size;
    return v;
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new Error('CBOR: too deep');
    need(1);
    const b = buf[pos++]!;
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        need(n);
        const out = Buffer.from(buf.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 3: {
        const n = length(info);
        need(n);
        const out = buf.toString('utf8', pos, pos + n);
        pos += n;
        return out;
      }
      case 4: {
        const n = length(info);
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = length(info);
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) m.set(item(depth + 1), item(depth + 1));
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error('CBOR: unsupported simple value');
      default:
        throw new Error('CBOR: unsupported major type');
    }
  };
  return item(0);
}

/** Minimal encoder (tests and fixtures). */
export function encodeCbor(v: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  return Buffer.from([0xf6]);
}
