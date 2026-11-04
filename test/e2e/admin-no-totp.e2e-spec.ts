import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { hashPassword } from '../../src/modules/admin/admin-crypto';

const PASSWORD = 'correct-horse-battery';

describe('Admin sign-in with ADMIN_TOTP_REQUIRED=false (development only)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ ADMIN_TOTP_REQUIRED: 'false' });
    // No TOTP secret at all: password alone is enough while the flag is off.
    await t.get<Model<unknown>>(getModelToken('AdminUser')).create({ email: 'owner@nouri.dev', role: 'owner', passwordHash: hashPassword(PASSWORD) });
  });
  afterAll(() => t.close());

  it('opens the session straight after the password', async () => {
    await t.http().post('/v1/admin/auth/login').send({ email: 'owner@nouri.dev', password: 'wrong-password' }).expect(401);
    const l = await t.http().post('/v1/admin/auth/login').send({ email: 'owner@nouri.dev', password: PASSWORD }).expect(200);
    expect(l.body).toMatchObject({ totpRequired: false, session: { email: 'owner@nouri.dev', role: 'owner', idleTimeoutSec: 1800 } });
    const cookies = (l.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    expect(cookies.some((c) => c.startsWith('__Host-nouri_admin='))).toBe(true);
    await t.http().get('/v1/admin/auth/session').set('Cookie', cookies.join('; ')).expect(200);
  });
});
