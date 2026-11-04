import { Types } from 'mongoose';
import { sanitize } from './sanitize.interceptor';

describe('response sanitiser (BI-6)', () => {
  it('renames _id, drops __v and stringifies ObjectIds, deeply', () => {
    const id = new Types.ObjectId();
    const out = sanitize({ _id: id, __v: 3, userId: id, items: [{ _id: 'a', __v: 0, n: 1 }], when: new Date(0), nested: { keep: true } });
    expect(out).toEqual({ id: id.toString(), userId: id.toString(), items: [{ id: 'a', n: 1 }], when: new Date(0), nested: { keep: true } });
    expect(sanitize({ id: 'x', _id: 'y' })).toEqual({ id: 'x' });
    expect(sanitize(null)).toBeNull();
    const buf = Buffer.from('x');
    expect(sanitize(buf)).toBe(buf);
  });
});
