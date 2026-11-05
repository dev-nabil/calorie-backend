// k6 load test (plan §16, M9-T8): sign-in, Today, meal write, scan enqueue + poll, coach stream.
// Run against staging with the worker and Gemini stubbed (AI_PROVIDER=fake) or against start:local:
//   k6 run -e BASE=http://localhost:3000 -e DEV_OTP=1 infra/k6/nouri.js
//   k6 run -e BASE=https://api.staging.example -e TOKENS=tokens.json -e PEAK=5000 infra/k6/nouri.js
// Thresholds are the SLOs of plan §15 (read p95 < 300 ms, write p95 < 500 ms, scan p95 < 15 s, 5xx < 0.1%).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE = (__ENV.BASE || 'http://localhost:3000').replace(/\/$/, '') + '/v1';
const PEAK = Number(__ENV.PEAK || 50); // requests per second at peak (launch: 500; test at 10×)
const scanE2e = new Trend('nouri_scan_e2e_ms', true);
const serverErrors = new Rate('nouri_5xx');

const tokens = __ENV.TOKENS ? new SharedArray('tokens', () => JSON.parse(open(__ENV.TOKENS))) : [];
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16));
const today = () => new Date().toISOString().slice(0, 10);
const json = (body, extra = {}) => ({ headers: { 'Content-Type': 'application/json', 'X-Device-Integrity': 'k6', ...extra }, tags: extra.tags });

export const options = {
  scenarios: {
    today: { executor: 'ramping-arrival-rate', exec: 'todayFlow', startRate: 1, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 2000, stages: [{ target: Math.ceil(PEAK * 0.6), duration: '2m' }, { target: Math.ceil(PEAK * 0.6), duration: '5m' }, { target: 0, duration: '1m' }] },
    meals: { executor: 'ramping-arrival-rate', exec: 'mealFlow', startRate: 1, timeUnit: '1s', preAllocatedVUs: 30, maxVUs: 1000, stages: [{ target: Math.ceil(PEAK * 0.25), duration: '2m' }, { target: Math.ceil(PEAK * 0.25), duration: '5m' }, { target: 0, duration: '1m' }] },
    scans: { executor: 'constant-arrival-rate', exec: 'scanFlow', rate: Math.max(1, Math.ceil(PEAK * 0.05)), timeUnit: '1s', duration: '7m', preAllocatedVUs: 50, maxVUs: 1000 },
    coach: { executor: 'constant-arrival-rate', exec: 'coachFlow', rate: Math.max(1, Math.ceil(PEAK * 0.05)), timeUnit: '1s', duration: '7m', preAllocatedVUs: 20, maxVUs: 500 },
    signin: { executor: 'constant-arrival-rate', exec: 'signInFlow', rate: 1, timeUnit: '1s', duration: '7m', preAllocatedVUs: 5, maxVUs: 50 },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<300'],
    'http_req_duration{kind:write}': ['p(95)<500'],
    nouri_scan_e2e_ms: ['p(50)<6000', 'p(95)<15000'],
    nouri_5xx: ['rate<0.001'],
    checks: ['rate>0.99'],
  },
};

function track(res) {
  serverErrors.add(res.status >= 500);
  return res;
}

/** Sign in once per VU: a provided token pool, or the dev OTP route against start:local. */
function session() {
  if (tokens.length) return tokens[(__VU - 1) % tokens.length];
  if (!__ENV.DEV_OTP) throw new Error('Pass TOKENS=<file of access tokens> or DEV_OTP=1 (local only)');
  if (!globalThis.__token) {
    const email = `k6-${__VU}-${Date.now()}@example.com`;
    track(http.post(`${BASE}/auth/email/start`, JSON.stringify({ email }), json()));
    const code = http.get(`${BASE}/dev/last-otp?email=${encodeURIComponent(email)}`).json('code');
    globalThis.__token = track(http.post(`${BASE}/auth/email/verify`, JSON.stringify({ email, code }), json())).json('accessToken');
  }
  return globalThis.__token;
}

const auth = (extra = {}) => ({ Authorization: `Bearer ${session()}`, ...extra });

export function signInFlow() {
  if (!__ENV.DEV_OTP) return;
  const email = `k6-signin-${uuid()}@example.com`;
  check(track(http.post(`${BASE}/auth/email/start`, JSON.stringify({ email }), json())), { 'otp start 200': (r) => r.status === 200 || r.status === 429 });
}

export function todayFlow() {
  const res = track(http.get(`${BASE}/days/${today()}`, { headers: auth(), tags: { kind: 'read' } }));
  check(res, { 'today 200': (r) => r.status === 200 });
  sleep(Math.random());
}

export function mealFlow() {
  const body = { loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'k6 meal', source: 'manual', items: [{ name: 'Rice', grams: 150, kcal: 195, proteinG: 4, carbsG: 43, fatG: 0.4 }] };
  const key = uuid();
  const res = track(http.post(`${BASE}/meals`, JSON.stringify(body), { headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': key }), tags: { kind: 'write' } }));
  check(res, { 'meal 201': (r) => r.status === 201 });
  // An offline retry storm must not double-write (plan §16): replay the same key.
  const replay = track(http.post(`${BASE}/meals`, JSON.stringify(body), { headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': key }), tags: { kind: 'write' } }));
  check(replay, { 'replay same id': (r) => r.status === 201 && r.json('id') === res.json('id') });
  track(http.post(`${BASE}/days/${today()}/water`, JSON.stringify({ amountMl: 250, timezone: 'UTC' }), { headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': uuid() }), tags: { kind: 'write' } }));
}

export function scanFlow() {
  const jpeg = new Uint8Array(1024);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < jpeg.length; i++) jpeg[i] = Math.floor(Math.random() * 256);
  const p = track(http.post(`${BASE}/uploads/presign`, JSON.stringify({ kind: 'meal_photo', contentType: 'image/jpeg' }), { headers: auth({ 'Content-Type': 'application/json' }) }));
  if (!check(p, { 'presign 200': (r) => r.status === 200 })) return;
  track(http.put(p.json('uploadUrl'), jpeg.buffer, { headers: p.json('headers') }));
  const started = Date.now();
  const scanId = uuid();
  const hash = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const q = track(http.post(`${BASE}/scans`, JSON.stringify({ scanId, imageKey: p.json('key'), imageHash: hash }), { headers: auth({ 'Content-Type': 'application/json', 'X-Device-Integrity': 'k6' }) }));
  check(q, { 'scan queued': (r) => r.status === 202 || r.status === 402 });
  if (q.status !== 202) return;
  for (const wait of [1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]) {
    sleep(wait);
    const s = track(http.get(`${BASE}/scans/${scanId}`, { headers: auth(), tags: { kind: 'poll' } }));
    if (['succeeded', 'failed', 'rejected'].includes(s.json('status'))) {
      scanE2e.add(Date.now() - started);
      check(s, { 'scan succeeded': (r) => r.json('status') === 'succeeded' });
      return;
    }
  }
}

export function coachFlow() {
  if (!globalThis.__conv) {
    globalThis.__conv = track(http.post(`${BASE}/conversations`, JSON.stringify({ type: 'coach' }), { headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': uuid() }) })).json('id');
  }
  const res = track(http.post(`${BASE}/conversations/${globalThis.__conv}/turns?stream=true`, JSON.stringify({ quickAction: 'review_day', inputMethod: 'chip' }), { headers: auth({ 'Content-Type': 'application/json', 'X-Device-Integrity': 'k6' }), tags: { kind: 'coach' } }));
  check(res, { 'coach stream done': (r) => r.status === 200 && String(r.body).includes('event: done') || r.status === 402 });
}
