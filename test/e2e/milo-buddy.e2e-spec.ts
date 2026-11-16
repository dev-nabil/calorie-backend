import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';

const n = (kcal: number, p: number, c: number, f: number) => ({ kcal, p, c, f, fib: 0, sug: 0, na: 0 });
const op = (o: Record<string, unknown>) => ({
  op: 'add_item', kind: null, itemId: null, name: null, en: null, qty: null, unit: null, g: null, stated: null, state: null, bone: null, prep: null, proc: null, n: null, assume: null, count: null, portionKind: null, value: null, recipeId: null, ...o,
});
const RECIPE = [
  op({ op: 'start_draft', kind: 'recipe', name: 'Chicken curry' }),
  op({ name: 'Chicken', en: 'chicken breast', qty: 500, unit: 'g', g: 500, stated: true, state: 'raw', n: n(120, 22, 0, 3) }),
  op({ name: 'Oil', en: 'mustard oil', qty: 30, unit: 'g', g: 30, stated: true, n: n(884, 0, 0, 100) }),
  op({ name: 'Onion', en: 'onion', qty: 100, unit: 'g', g: 100, stated: true, state: 'raw', n: n(40, 1.1, 9.3, 0.1) }),
];

describe('Milo buddy: turns, drafts, actions (decision 0016)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  beforeAll(async () => {
    t = await createTestApp();
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const start = async (h: Record<string, string>) => (await t.http().post('/v1/conversations').set(h).set(idem()).send({ type: 'coach' }).expect(201)).body;
  const turn = (h: Record<string, string>, id: string, body: object) => t.http().post(`/v1/conversations/${id}/turns`).set(h).set(INTEGRITY).send({ inputMethod: 'typed', clientTurnId: randomUUID(), ...body });

  it('recipe → clarification → portion → tracker, with corrections that never duplicate and retries that never repeat', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    // 1. Ingredients, with one material question (bone): the card is there and the question is the reply.
    fake.enqueueInterpret({ intent: 'recipe', ops: RECIPE, clarify: { question: 'Was the 500 g chicken weighed with the bone?', itemIds: ['i1'] } });
    const r1 = await turn(h, c.id, { text: 'Ami 500 g murgi, 30 g tel ar 100 g peyaj diye ranna korechi' }).expect(200);
    expect(r1.body.reply).toBe('Was the 500 g chicken weighed with the bone?');
    expect(r1.body.draft).toMatchObject({ kind: 'recipe', version: 1, totals: { kcal: 905 } });
    expect(r1.body.cards.map((x: { type: string }) => x.type)).toEqual(['recipe', 'portion']);
    expect(fake.chatCalls).toHaveLength(0); // the clarification needed no second model call
    // 2. Answer + portion.
    fake.enqueueInterpret({ intent: 'portion', ops: [op({ op: 'update_item', itemId: 'i1', bone: 'out' }), op({ op: 'set_servings', count: 4 }), op({ op: 'set_portion', portionKind: 'servings', value: 1 })] });
    fake.enqueue('Your quarter is about 226 kcal.');
    const r2 = await turn(h, c.id, { text: 'Boneless. Divided into four equal servings and ate one.', draftVersion: 1 }).expect(200);
    expect(r2.body.draft).toMatchObject({ version: 2, portionTotals: { kcal: 226 } });
    // 3. Correction: an update, not a new entry.
    fake.enqueueInterpret({ intent: 'correction', ops: [op({ op: 'update_item', itemId: 'i2', qty: 20, unit: 'g', g: 20, stated: true })] });
    fake.enqueue('Oil is now 20 g.');
    const r3 = await turn(h, c.id, { text: 'Actually, the oil was 20 g', draftVersion: 2 }).expect(200);
    expect(r3.body.draft.items).toHaveLength(3);
    expect(r3.body.draft).toMatchObject({ version: 3, portionTotals: { kcal: 204 } });
    // 4. Add my portion: tapped twice with two keys, then retried: one meal.
    const portion = r3.body.cards.find((x: { type: string }) => x.type === 'portion');
    const log = portion.actions.find((a: { type: string }) => a.type === 'log_portion');
    expect(log).toMatchObject({ enabled: true, blockedBy: null });
    const body = { draftVersion: 3, date: r3.body.draft.updatedAt.slice(0, 10), category: 'lunch', timezone: 'UTC' };
    const a1 = await t.http().post(`/v1/conversations/${c.id}/actions/${log.id}`).set(h).set(idem()).send(body).expect(200);
    const a2 = await t.http().post(`/v1/conversations/${c.id}/actions/${log.id}`).set(h).set(idem()).send(body).expect(200);
    expect(a1.body.meal.id).toBe(a2.body.meal.id);
    expect(a1.body.meal.totals.kcal).toBe(204);
    expect(a1.body.card.actions.map((x: { type: string }) => x.type)).toEqual(['open_meal', 'undo']);
    const day = await t.http().get(`/v1/days/${body.date}`).set(h).expect(200);
    expect(day.body.meals).toHaveLength(1);
    expect(day.body.totals.kcal).toBe(204);
    // A stale card cannot act.
    const stale = await t.http().post(`/v1/conversations/${c.id}/actions/${r1.body.cards[1].actions[1].id}`).set(h).set(idem()).send({ draftVersion: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { draft: { version: 3 } } });
    // 5. Retry of turn 3 with the same key: the stored reply, no new model call.
    const before = fake.calls.length + fake.chatCalls.length;
    const key = randomUUID();
    fake.enqueueInterpret({ intent: 'chat' });
    fake.enqueue('Fine.');
    const once = await turn(h, c.id, { text: 'thanks', clientTurnId: key }).expect(200);
    const again = await turn(h, c.id, { text: 'thanks', clientTurnId: key }).expect(200);
    expect(again.body).toEqual(once.body);
    expect(fake.calls.length + fake.chatCalls.length - before).toBe(2);
  });

  it('a card edit wins over a slower AI answer (version check); PATCH and lifecycle', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    fake.enqueueInterpret({ intent: 'recipe', ops: RECIPE });
    fake.enqueue('Done.');
    await turn(h, c.id, { text: 'I cooked 500 g chicken, 30 g oil and 100 g onion' }).expect(200);
    const edit = await t.http().patch(`/v1/conversations/${c.id}/draft`).set(h).send({ version: 1, ops: [{ op: 'update_item', itemId: 'i2', grams: 15 }] }).expect(200);
    expect(edit.body.draft).toMatchObject({ version: 2 });
    expect(edit.body.cards[0].type).toBe('recipe');
    const stale = await t.http().patch(`/v1/conversations/${c.id}/draft`).set(h).send({ version: 1, ops: [{ op: 'update_item', itemId: 'i2', grams: 40 }] }).expect(409);
    expect(stale.body.error.details.draft.version).toBe(2);
    const state = await t.http().get(`/v1/conversations/${c.id}/draft`).set(h).expect(200);
    expect(state.body.draft.items[1].grams).toBe(15);
    const fresh = await t.http().post(`/v1/conversations/${c.id}/draft`).set(h).send({ action: 'new' }).expect(200);
    expect(fresh.body).toMatchObject({ draft: null, parked: [{ name: 'Chicken curry' }] });
    const resumed = await t.http().post(`/v1/conversations/${c.id}/draft`).set(h).send({ action: 'resume', draftId: fresh.body.parked[0].id }).expect(200);
    expect(resumed.body.draft.version).toBe(2);
    const latest = await t.http().get('/v1/conversations/latest?type=coach').set(h).expect(200);
    expect(latest.body).toMatchObject({ id: c.id, draft: { version: 2 } });
  });

  it('activity numbers from the phone are used live but never stored; missing logs stay unknown', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const budget = { addActivity: true, activityAdjustmentKcal: 140, activeKcal: 457 };
    const r = await turn(h, c.id, { quickAction: 'review_day', inputMethod: 'chip', budget }).expect(200);
    const card = r.body.cards.find((x: { type: string }) => x.type === 'day_summary');
    expect(card.slots.every((s: { kcal: number | null }) => s.kcal === null)).toBe(true);
    const conn = t.get<Connection>(getConnectionToken());
    for (const name of ['messages', 'conversations', 'chat_drafts', 'chat_actions', 'kv']) {
      const docs = await conn.collection(name).find({}).toArray();
      expect(JSON.stringify(docs)).not.toMatch(/activityAdjustmentKcal|activeKcal|addActivity/);
    }
    // The prompt of this turn knew activity was synced (live only; a habits-only person gets no calorie numbers).
    expect(fake.chatCalls.at(-1)?.messages.at(-1)?.content ?? '').toContain('activitySynced');
    const history = await t.http().get(`/v1/conversations/${c.id}/messages`).set(h).expect(200);
    expect(JSON.stringify(history.body)).not.toMatch(/activityAdjustmentKcal|activeKcal/);
  });

  it('recipes, memory and the config flag', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const created = await t.http().post('/v1/recipes').set(h).set(idem()).send({ name: 'Dal', items: [{ name: 'Lentils', grams: 200, per100g: { kcal: 350, proteinG: 25, carbsG: 60, fatG: 1.5, fiberG: null, sugarG: null, sodiumMg: null } }], servings: 4 }).expect(201);
    expect(created.body).toMatchObject({ version: 1, totals: { kcal: 700 } });
    await t.http().patch(`/v1/recipes/${created.body.id}`).set(h).send({ version: 1, name: 'Masoor dal' }).expect(200);
    await t.http().patch(`/v1/recipes/${created.body.id}`).set(h).send({ version: 1, name: 'Again' }).expect(409);
    expect((await t.http().get('/v1/recipes').set(h).expect(200)).body.items).toHaveLength(1);
    await t.http().delete(`/v1/recipes/${created.body.id}`).set(h).expect(204);
    const memory = await t.http().get('/v1/coach/memory').set(h).expect(200);
    expect(memory.body).toMatchObject({ memories: [], settings: { chatMemory: true, replyLength: 'normal' }, canSave: false, retention: { chatMonths: 12 } });
    const off = await t.http().patch('/v1/coach/memory/settings').set(h).send({ chatMemory: false, replyLength: 'short' }).expect(200);
    expect(off.body.settings).toEqual({ chatMemory: false, replyLength: 'short' });
    await t.http().delete('/v1/coach/memory').set(h).expect(204);
    await t.http().delete('/v1/coach/memory/m_0123456789abcdef0123').set(h).expect(404);
    const config = await t.http().get('/v1/config').set(h).expect(200);
    expect(config.body.flags['features.miloBuddy']).toBe(true);
  });
});
