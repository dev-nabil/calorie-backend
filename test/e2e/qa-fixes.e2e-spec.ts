import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn, uploadPhoto } from '../setup/helpers';
import { buildOpenApi } from '../../src/app.setup';
import { clock } from '../../src/common/clock';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { InlineScanQueue, ScanQueue } from '../../src/modules/scans/scan-queue';

describe('QA round fixes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
  });
  afterEach(async () => {
    t.get<FakeAiProvider>(AiProvider).reset();
    clock.setOffset(0);
  });
  afterAll(() => t.close());

  it('P2: a poll during charging never sees succeeded without the charge', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const { key, hash } = await uploadPhoto(t, h);
    const scanId = randomUUID();
    const users = t.get<Model<unknown>>(getModelToken('User'));
    const original = users.updateOne.bind(users);
    const seen: Array<{ status: string; chargedFreeScan: boolean }> = [];
    const spy = jest.spyOn(users, 'updateOne').mockImplementation(((filter: unknown, update: unknown, opts: unknown) => {
      if (JSON.stringify(update).includes('freeScans.used')) {
        return (async () => {
          const poll = await t.http().get(`/v1/scans/${scanId}`).set(h);
          seen.push(poll.body);
          return original(filter as never, update as never, opts as never);
        })();
      }
      return original(filter as never, update as never, opts as never);
    }) as never);
    await t.http().post('/v1/scans').set(h).set(INTEGRITY).send({ scanId, imageKey: key, imageHash: hash }).expect(202);
    await (t.get<ScanQueue>(ScanQueue) as InlineScanQueue).drain();
    spy.mockRestore();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status === 'succeeded' && !seen[0]!.chargedFreeScan).toBe(false);
    const done = await t.http().get(`/v1/scans/${scanId}`).set(h).expect(200);
    expect(done.body).toMatchObject({ status: 'succeeded', chargedFreeScan: true });
  });

  it('P2: nullable enums list null and nullable refs carry a type', () => {
    const doc = buildOpenApi(t.app) as unknown as Record<string, unknown>;
    const bad: string[] = [];
    const walk = (n: unknown, path: string) => {
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (o.nullable === true && Array.isArray(o.enum) && !o.enum.includes(null)) bad.push(`${path} enum`);
      // OAS 3.0 ignores `nullable` without `type`, also next to anyOf/oneOf (QA B24).
      if (o.nullable === true && o.type === undefined) bad.push(`${path} type`);
      if (o.type === 'null') bad.push(`${path} type:null (not OpenAPI 3.0)`);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(doc, '');
    expect(bad).toEqual([]);
    const value = ((doc.components as { schemas: Record<string, { properties: Record<string, { oneOf?: Record<string, unknown>[] }> }> }).schemas.AnswerInput!.properties.value!);
    expect(value.oneOf?.map((m) => m.type)).toEqual(['string', 'array', 'number', 'object']);
    expect(value.oneOf?.filter((m) => m.nullable)).toHaveLength(1);
  });

  it('B24: every operation with a body documents 400 and every secured operation documents 401', () => {
    const doc = buildOpenApi(t.app) as unknown as { security: Record<string, unknown>[]; paths: Record<string, Record<string, { requestBody?: unknown; security?: Record<string, unknown>[]; responses: Record<string, unknown> }>> };
    const missing: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (op.requestBody && !op.responses['400']) missing.push(`${method} ${path} 400`);
        if ((op.security ?? doc.security).some((s) => Object.keys(s).length > 0) && !op.responses['401']) missing.push(`${method} ${path} 401`);
      }
    }
    expect(missing).toEqual([]);
    const rc = doc.paths['/v1/webhooks/revenuecat']!.post!;
    expect(Object.keys(rc.responses).sort()).toEqual(['200', '400', '401', '503']);
  });

  it('P3: every mounted non-dev route is in the committed openapi.json, and dev routes are not', () => {
    const committed = JSON.parse(readFileSync(resolve(__dirname, '../../openapi/openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const express = t.app.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
    const mounted = express.router.stack
      .filter((l) => l.route?.path.startsWith('/v1/'))
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path.replace(/:(\w+)/g, '{$1}')}`));
    expect(mounted.length).toBeGreaterThan(30);
    const missing = mounted.filter((r) => !r.includes('/v1/dev/')).filter((r) => {
      const [method, path] = r.split(' ') as [string, string];
      return !committed.paths[path]?.[method.toLowerCase()];
    });
    expect(missing).toEqual([]); // run `pnpm openapi` when this fails
    expect(Object.keys(committed.paths).filter((p) => p.startsWith('/v1/dev/'))).toEqual([]);
    expect(mounted.some((r) => r.includes('/v1/dev/'))).toBe(true);
  });

  it('BI-4/BI-5: every operation documents a success response; CSRF only on admin writes', () => {
    const doc = buildOpenApi(t.app) as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content?: unknown }>; parameters?: { name: string }[] }>> };
    const missing: string[] = [];
    const csrf: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (path.startsWith('/v1/dev/')) continue;
        const ok = Object.entries(op.responses ?? {}).some(([code, r]) => code === '204' || code === '304' || (code.startsWith('2') && r.content));
        if (!ok) missing.push(`${method.toUpperCase()} ${path}`);
        if (op.parameters?.some((p) => p.name === 'X-CSRF-Token') && (method === 'get' || !path.startsWith('/v1/admin/'))) csrf.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
    expect(csrf).toEqual([]);
  });

  it('BI-6: responses carry no Mongo internals', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const res = await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'd-1', platform: 'ios' }).expect(201);
    const me = await t.http().get('/v1/me').set(h).expect(200);
    for (const body of [res.body, me.body]) expect(JSON.stringify(body)).not.toMatch(/"(_id|__v)"/);
  });

  it('dev hooks: fake AI modes and the clock offset', async () => {
    const h = bearer((await signIn(t)).accessToken);
    expect((await t.http().post('/v1/dev/ai-mode').send({ mode: 'unavailable' }).expect(200)).body.mode).toBe('unavailable');
    expect((await t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).send({ text: 'toast' }).expect(503)).body.error.code).toBe('AI_UNAVAILABLE');
    await t.http().post('/v1/dev/ai-mode').send({ mode: 'not_food' }).expect(200);
    expect((await t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).send({ text: 'a chair' }).expect(200)).body).toMatchObject({ items: [], clarifyingQuestion: 'What did you eat?' });
    await t.http().post('/v1/dev/ai-mode').send({ mode: 'bogus' }).expect(400);

    const meal = await t
      .http()
      .post('/v1/meals')
      .set(h)
      .set(idem())
      .send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'snack', name: 'Apple', source: 'manual', items: [] })
      .expect(201);
    await t.http().delete(`/v1/meals/${meal.body.id}`).set(h).expect(200);
    const moved = await t.http().post('/v1/dev/clock').send({ offsetMs: 8 * 86_400_000 }).expect(200);
    expect(moved.body.offsetMs).toBe(8 * 86_400_000);
    expect((await t.http().post(`/v1/meals/${meal.body.id}/restore`).set(h).expect(409)).body.error.code).toBe('MEAL_RESTORE_EXPIRED');
    await t.http().post('/v1/dev/clock').send({ offsetMs: 0 }).expect(200);
    expect((await t.http().get('/v1/dev/clock').expect(200)).body.offsetMs).toBe(0);
  });

  it('mobile: a photo-only meal ("Save photo and finish later") drives the savedPhoto nudge', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const { key } = await uploadPhoto(t, h);
    const today = new Date().toISOString().slice(0, 10);
    const res = await t
      .http()
      .post('/v1/meals')
      .set(h)
      .set(idem())
      .send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'Lunch photo', source: 'photo', imageKey: key, items: [] })
      .expect(201);
    expect(res.body.photo).toMatchObject({ key, url: expect.any(String) });
    const day = await t.http().get(`/v1/days/${today}`).set(h).expect(200);
    expect(day.body.nudge?.id).toBe('nudge.savedPhoto');
    const other = bearer((await signIn(t)).accessToken);
    await t.http().post('/v1/meals').set(other).set(idem()).send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'x', source: 'photo', imageKey: key, items: [] }).expect(400);
  });
});

describe('P1 trust proxy', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('P1: a spoofed X-Forwarded-For does not change the per-IP limiter key (TRUST_PROXY unset)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await t
        .http()
        .post('/v1/auth/email/start')
        .set(INTEGRITY)
        .set('X-Forwarded-For', `203.0.113.${i}`)
        .send({ email: `spoof-${i}@example.com` });
      codes.push(res.status);
    }
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

});

describe('RATE_LIMIT_MULTIPLIER (test suites only)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ RATE_LIMIT_MULTIPLIER: '100' });
  });
  afterAll(() => t.close());
  it('relaxes limits and the resend cooldown', async () => {
    for (let i = 0; i < 8; i++) await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: `many-${i % 2}@example.com` }).expect((r) => expect([200, 429]).toContain(r.status));
    await new Promise((r) => setTimeout(r, 1100));
    await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: 'many-0@example.com' }).expect(200);
  });
});
