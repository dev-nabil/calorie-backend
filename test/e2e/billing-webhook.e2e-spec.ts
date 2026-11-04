import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, seedAdmins, signIn } from '../setup/helpers';
import { BillingEventsService } from '../../src/modules/billing/services/billing-events.service';
import { RevenueCatWebhookController } from '../../src/modules/billing/controllers/revenuecat-webhook.controller';
import type { AppConfig } from '../../src/config/env';
import type { Request } from 'express';

const SECRET = 'rc-webhook-secret-for-tests';
const day = 86_400_000;

describe('RevenueCat webhook (M6-T2) and admin billing (M7-T6)', () => {
  let t: TestApp;
  let login: Awaited<ReturnType<typeof seedAdmins>>;
  beforeAll(async () => {
    t = await createTestApp({ REVENUECAT_WEBHOOK_SECRET: SECRET });
    login = await seedAdmins(t);
  });
  afterAll(() => t.close());

  const post = (event: Record<string, unknown>, auth = `Bearer ${SECRET}`) =>
    t.http().post('/v1/webhooks/revenuecat').set('Authorization', auth).send({ api_version: '1.0', event });
  const event = (userId: string, type: string, over: Record<string, unknown> = {}) => ({
    id: `${type}-${userId}-${Math.random().toString(36).slice(2)}`,
    type,
    app_user_id: userId,
    product_id: 'nouri_plus_yearly',
    store: 'APP_STORE',
    event_timestamp_ms: Date.now(),
    purchased_at_ms: Date.now(),
    expiration_at_ms: Date.now() + 365 * day,
    original_transaction_id: 'txn-1',
    ...over,
  });

  it('rejects a wrong secret', async () => {
    await post({ id: 'x', type: 'TEST', app_user_id: 'x' }, 'Bearer nope').expect(401);
  });

  it('B23: checks the secret before the body, and 503 without a configured secret', async () => {
    const noAuth = await t.http().post('/v1/webhooks/revenuecat').send({ bogus: true }).expect(401);
    expect(noAuth.body.error.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(noAuth.body)).not.toMatch(/event|issues/);
    await t.http().post('/v1/webhooks/revenuecat').set('Authorization', 'Bearer nope').send('not json').expect(401);
    const bad = await t.http().post('/v1/webhooks/revenuecat').set('Authorization', `Bearer ${SECRET}`).send({ bogus: true }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const unconfigured = new RevenueCatWebhookController({} as AppConfig, {} as BillingEventsService);
    await expect(unconfigured.revenuecat({ header: () => undefined } as unknown as Request, {})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('purchase → Plus, idempotent by event id, refund → Free at once (BR-03)', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().get('/v1/billing/entitlement').set(h).expect(200); // warm the 60 s cache
    const buy = event(s.user.id, 'INITIAL_PURCHASE');
    expect((await post(buy).expect(200)).body).toEqual({ status: 'processed' });
    expect((await post(buy).expect(200)).body).toEqual({ status: 'duplicate' });
    expect((await t.http().get('/v1/billing/entitlement').set(h).expect(200)).body).toMatchObject({ plan: 'plus', isPlus: true, period: 'yearly', source: 'app_store' });
    await post(event(s.user.id, 'CANCELLATION', { cancel_reason: 'UNSUBSCRIBE', event_timestamp_ms: Date.now() + 10 })).expect(200);
    expect((await t.http().get('/v1/billing/entitlement').set(h)).body.isPlus).toBe(true);
    await post(event(s.user.id, 'CANCELLATION', { cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: Date.now() + 20 })).expect(200);
    expect((await t.http().get('/v1/billing/entitlement').set(h)).body).toMatchObject({ plan: 'free', isPlus: false });
  });

  it('grace period keeps Plus; expiration ends it', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await post(event(s.user.id, 'RENEWAL', { product_id: 'nouri_plus_monthly', store: 'PLAY_STORE', original_transaction_id: 'gp-1' })).expect(200);
    await post(event(s.user.id, 'BILLING_ISSUE', { store: 'PLAY_STORE', original_transaction_id: 'gp-1', expiration_at_ms: Date.now() - 1000, grace_period_expiration_at_ms: Date.now() + 3 * day, event_timestamp_ms: Date.now() + 10 })).expect(200);
    expect((await t.http().get('/v1/billing/entitlement').set(h)).body).toMatchObject({ isPlus: true, source: 'play_store' });
    await post(event(s.user.id, 'EXPIRATION', { store: 'PLAY_STORE', original_transaction_id: 'gp-1', expiration_at_ms: Date.now() - 1000, event_timestamp_ms: Date.now() + 20 })).expect(200);
    expect((await t.http().get('/v1/billing/entitlement').set(h)).body.isPlus).toBe(false);
  });

  it('unknown users fail and can be replayed by an admin; subscriptions are listed', async () => {
    const orphan = event('a'.repeat(24), 'INITIAL_PURCHASE');
    expect((await post(orphan).expect(200)).body.status).toBe('failed');
    const admin = await login('admin');
    const failed = await t.http().get('/v1/admin/billing-events').query({ status: 'failed' }).set(admin).expect(200);
    const row = failed.body.items.find((e: { externalId: string }) => e.externalId === orphan.id);
    expect(row).toMatchObject({ type: 'INITIAL_PURCHASE', status: 'failed', error: 'unknown app_user_id', product: 'plus_yearly' });
    expect((await t.http().post(`/v1/admin/billing-events/${row.id}/replay`).set(admin).send({ reason: 'retry after fix' }).expect(200)).body.status).toBe('failed');
    const support = await login('support');
    await t.http().post(`/v1/admin/billing-events/${row.id}/replay`).set(support).send({ reason: 'not allowed' }).expect(403);
    const subs = await t.http().get('/v1/admin/subscriptions').set(support).expect(200);
    expect(subs.body.items.length).toBeGreaterThanOrEqual(2);
    expect(subs.body.items[0]).toMatchObject({ userEmail: expect.stringContaining('@example.com'), product: expect.stringMatching(/^plus_/) });
  });
});
