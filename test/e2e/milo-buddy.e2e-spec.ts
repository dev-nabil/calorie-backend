import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { KvStore } from '../../src/infra/kv/kv-store';
import { ApiError } from '../../src/common/errors/api-error';
import { UsersService } from '../../src/modules/users/users.service';

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

  it('logs from chat only when the message asks for it; a correction of a logged meal never logs it twice', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const date = new Date().toISOString().slice(0, 10);
    const meals = async () => (await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.meals;
    const eggs = op({ name: 'Boiled eggs', en: 'boiled egg', qty: 2, unit: 'piece', g: 100, stated: true, n: n(155, 13, 1.1, 11) });
    // Live Gemini sets `act` for a plain description: the server only runs it when the words ask for it.
    fake.enqueueInterpret({ intent: 'log_food', ops: [eggs], act: { type: 'log', category: 'breakfast', day: null } });
    fake.enqueue('Two eggs, about 155 kcal.');
    const r1 = await turn(h, c.id, { text: 'For breakfast I had 2 boiled eggs', timezone: 'UTC' }).expect(200);
    expect(r1.body.executed).toEqual([]);
    expect(r1.body.cards[0].actions.find((a: { type: string }) => a.type === 'log_meal')).toMatchObject({ enabled: true });
    expect(await meals()).toHaveLength(0);
    // Asked: logged once.
    fake.enqueueInterpret({ intent: 'log_food', act: { type: 'log', category: 'breakfast', day: null } });
    fake.enqueue('Added to breakfast.');
    const r2 = await turn(h, c.id, { text: 'Log it please', timezone: 'UTC' }).expect(200);
    expect(r2.body.executed.map((x: { type: string }) => x.type)).toEqual(['log_meal']);
    expect(await meals()).toHaveLength(1);
    // A correction of the logged meal changes the card, never the diary, even when the model repeats `act`.
    fake.enqueueInterpret({ intent: 'correction', ops: [op({ op: 'update_item', itemId: 'i1', qty: 3, unit: 'piece', g: 150, stated: true })], act: { type: 'log', category: 'breakfast', day: null } });
    fake.enqueue('Now three eggs.');
    const r3 = await turn(h, c.id, { text: 'make it 3 eggs and add it', timezone: 'UTC', draftVersion: 1 }).expect(200);
    expect(r3.body.draft).toMatchObject({ version: 2, items: [{ grams: 150 }] });
    expect(r3.body.executed).toEqual([]);
    expect(await meals()).toHaveLength(1);
    expect(fake.chatCalls.at(-1)?.messages.at(-1)?.content ?? '').toContain('log_meal:already_in_diary');
  });

  it('a meal logged by the turn itself is in the day the reply is written from (no stale "kcal left")', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    // Live run 16 Nov: "add it to lunch" logged 446 kcal, then the reply said what was left before that meal.
    fake.enqueueInterpret({ intent: 'log_food', ops: [op({ name: 'Zz test stew', en: 'zz test stew', qty: 250, unit: 'g', g: 250, stated: true, n: n(120, 7, 18, 2) })], act: { type: 'log', category: 'lunch', day: null } });
    fake.enqueue('Added to lunch.');
    const r = await turn(h, c.id, { text: 'I had 250 g of my stew, add it to lunch', timezone: 'UTC' }).expect(200);
    expect(r.body.executed[0].meal.totals.kcal).toBe(300);
    const prompt = fake.chatCalls.at(-1)?.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('"meals":[{"category":"lunch","name":"Zz test stew"');
  });

  it('the meal the person named stays with the draft: its cards, a card edit and the tap file it there (device test 16 Nov)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    // On the phone at 22:12 "I had 2 eggs and a slice of toast for breakfast" became a Snack entry named "Breakfast".
    const eggs = op({ name: 'Eggs', en: 'boiled egg', qty: 2, unit: 'piece', g: 100, stated: true, n: n(155, 13, 1.1, 11) });
    fake.enqueueInterpret({ intent: 'log_food', ops: [op({ op: 'start_draft', kind: 'meal', name: 'Breakfast' }), eggs], slot: 'breakfast' });
    fake.enqueue('Two eggs.');
    const r1 = await turn(h, c.id, { text: 'I had 2 eggs for breakfast', timezone: 'UTC' }).expect(200);
    expect(r1.body.draft.category).toBe('breakfast');
    expect(r1.body.cards[0]).toMatchObject({ type: 'meal', category: 'breakfast', items: [{ quantity: { text: '2 pieces' } }] });
    // A correction that names no meal keeps it.
    fake.enqueueInterpret({ intent: 'correction', ops: [op({ op: 'update_item', itemId: 'i1', qty: 3, unit: 'piece', g: 150, stated: true })] });
    fake.enqueue('Now three eggs.');
    const r2 = await turn(h, c.id, { text: 'make it 3 eggs', timezone: 'UTC', draftVersion: 1 }).expect(200);
    expect(r2.body.cards[0].category).toBe('breakfast');
    // So does a card edit.
    const p = await t.http().patch(`/v1/conversations/${c.id}/draft`).set(h).send({ version: r2.body.draft.version, ops: [{ op: 'update_item', itemId: 'i1', grams: 160 }] }).expect(200);
    expect(p.body.cards[0].category).toBe('breakfast');
    // "it was lunch, actually": the slot moves, the foods stay.
    fake.enqueueInterpret({ intent: 'correction', slot: 'lunch' });
    fake.enqueue('Moved to lunch.');
    const r3 = await turn(h, c.id, { text: 'it was lunch actually', timezone: 'UTC' }).expect(200);
    expect(r3.body.draft).toMatchObject({ category: 'lunch', version: p.body.draft.version + 1, items: [{ grams: 160 }] });
    expect(r3.body.cards[0].category).toBe('lunch');
    // A question that names a meal is not about the card: "what can I eat tonight?" leaves it at lunch.
    fake.enqueueInterpret({ intent: 'suggest', slot: 'dinner' });
    fake.enqueue('Some ideas.');
    const r4 = await turn(h, c.id, { text: 'what light thing can I eat tonight?', timezone: 'UTC' }).expect(200);
    expect(r4.body.cards.filter((x: { type: string }) => x.type === 'meal')).toEqual([]);
    const state = await t.http().get(`/v1/conversations/${c.id}/draft`).set(h).expect(200);
    expect(state.body.draft).toMatchObject({ category: 'lunch', version: r3.body.draft.version });
  });

  it('something unsafe to eat never reaches a card or the diary, even when asked to log it (as scans, rule 0)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const date = new Date().toISOString().slice(0, 10);
    // The live model logged "wild mushrooms from the park" and "200 g raw kidney beans" without a word of warning (16 Nov).
    fake.enqueueInterpret({
      intent: 'log_food',
      hazard: { level: 'danger', what: 'Wild mushrooms may be poisonous' },
      ops: [op({ name: 'Wild mushrooms', en: 'wild mushroom', qty: 100, unit: 'g', g: 100, stated: true, n: n(22, 3, 3, 0.3) })],
      act: { type: 'log', category: 'snack', day: null },
    });
    fake.enqueue('Those may be poisonous, so I have not added them.');
    const r = await turn(h, c.id, { text: 'I ate 100 g of wild mushrooms from the park an hour ago. Log it for me.', timezone: 'UTC' }).expect(200);
    expect(r.body).toMatchObject({ draft: null, cards: [], executed: [], clarify: null });
    expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.meals).toHaveLength(0);
    expect(fake.chatCalls.at(-1)?.messages.at(-1)?.content ?? '').toContain('Wild mushrooms may be poisonous');
  });

  it('accepts draftVersion null on a card action (the app sends null when it shows no draft)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    fake.enqueueInterpret({ intent: 'log_food', ops: [op({ name: 'Apple', en: 'apple', qty: 150, unit: 'g', g: 150, stated: true, n: n(52, 0.3, 14, 0.2) })] });
    fake.enqueue('An apple.');
    const r = await turn(h, c.id, { text: 'I ate a 150 g apple', timezone: 'UTC' }).expect(200);
    const log = r.body.cards[0].actions.find((a: { type: string }) => a.type === 'log_meal');
    const done = await t.http().post(`/v1/conversations/${c.id}/actions/${log.id}`).set(h).set(idem()).send({ draftVersion: null, timezone: 'UTC' }).expect(200);
    expect(done.body.meal.totals.kcal).toBe(r.body.draft.totals.kcal);
  });

  it('a message that never got an answer (daily limit, offline) is left out of what the model reads next (device test 16 Nov)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    fake.enqueueInterpret({ intent: 'chat' });
    fake.enqueue('Hello.');
    await turn(h, c.id, { text: 'hello there' }).expect(200);
    // The refused question stays in the chat (the person sees it), with no answer under it.
    const conn = t.get<Connection>(getConnectionToken());
    const last = await conn.collection('messages').findOne({ role: 'assistant' }, { sort: { _id: -1 } });
    await conn.collection('messages').insertOne({ ...last!, _id: undefined, role: 'user', text: 'how much water should I drink', clientTurnId: randomUUID(), snapshot: null, cards: [], createdAt: new Date(), updatedAt: new Date() });
    fake.enqueueInterpret({ intent: 'chat' });
    fake.enqueue('Apples and pears.');
    await turn(h, c.id, { text: 'what fruit is high in fiber' }).expect(200);
    const sent = JSON.stringify(fake.chatCalls.at(-1)?.messages ?? []);
    expect(sent).toContain('what fruit is high in fiber');
    expect(sent).toContain('hello there');
    expect(sent).not.toContain('how much water');
  });

  it('a retry that arrives just after the first answer was stored replays it (no second model call, no 500)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const key = randomUUID();
    fake.enqueueInterpret({ intent: 'chat' });
    fake.enqueue('First answer.');
    const first = await turn(h, c.id, { text: 'hello', clientTurnId: key }).expect(200);
    // The race: the retry's replay lookup runs before the first answer is stored, and it gets the lock right after.
    const conn = t.get<Connection>(getConnectionToken());
    const stored = await conn.collection('messages').findOne({ clientTurnId: key, role: 'assistant' });
    await conn.collection('messages').deleteOne({ _id: stored!._id });
    const kv = t.get<KvStore>(KvStore);
    const lock = kv.setIfAbsent.bind(kv);
    const spy = jest.spyOn(kv, 'setIfAbsent').mockImplementation(async (k, v, ttl) => {
      if (k.startsWith('turn:') && !(await conn.collection('messages').findOne({ _id: stored!._id }))) await conn.collection('messages').insertOne(stored!);
      return lock(k, v, ttl);
    });
    const before = fake.calls.length + fake.chatCalls.length;
    const again = await turn(h, c.id, { text: 'hello', clientTurnId: key }).expect(200);
    spy.mockRestore();
    expect(again.body).toEqual(first.body);
    expect(fake.calls.length + fake.chatCalls.length).toBe(before);
    expect(await conn.collection('messages').countDocuments({ clientTurnId: key })).toBe(2);
  });

  it('a card action left running by a crashed request runs again once the claim is stale', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    fake.enqueueInterpret({ intent: 'log_food', ops: [op({ name: 'Banana', en: 'banana', qty: 120, unit: 'g', g: 120, stated: true, n: n(89, 1.1, 23, 0.3) })] });
    fake.enqueue('A banana.');
    const r = await turn(h, c.id, { text: 'I had a 120 g banana', timezone: 'UTC' }).expect(200);
    const log = r.body.cards[0].actions.find((a: { type: string }) => a.type === 'log_meal');
    const conn = t.get<Connection>(getConnectionToken());
    await conn.collection('chat_actions').updateOne({ _id: log.id }, { $set: { status: 'running', claimedAt: new Date(Date.now() - 5 * 60_000) } });
    const done = await t.http().post(`/v1/conversations/${c.id}/actions/${log.id}`).set(h).set(idem()).send({ draftVersion: 1, timezone: 'UTC' }).expect(200);
    expect(done.body.meal.totals.kcal).toBe(r.body.draft.totals.kcal);
  });

  it('a memory or reminder proposed again after the person deleted it gets a new button that creates it again', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.get<UsersService>(UsersService).users.updateOne({ _id: s.user.id }, { $set: { entitlement: { plan: 'plus', period: 'monthly', activeUntil: new Date(Date.now() + 86400000), source: 'promo' } } });
    const c = await start(h);
    const button = (r: { body: { cards: { type: string; actions: { id: string; type: string }[] }[] } }, card: string, type: string) => r.body.cards.find((x) => x.type === card)!.actions.find((a) => a.type === type)!;
    const act = (id: string) => t.http().post(`/v1/conversations/${c.id}/actions/${id}`).set(h).set(idem()).send({ timezone: 'UTC' }).expect(200);
    const memory = { text: "Doesn't eat beef", category: 'dislike', sensitive: false, explicit: false };
    const reminder = { type: 'log_meal', time: '20:30', days: [], category: 'dinner', habit: null, label: null };
    const propose = async () => {
      fake.enqueueInterpret({ intent: 'memory', memory: [memory], reminder });
      fake.enqueue('Noted.');
      return turn(h, c.id, { text: "I don't eat beef. Remind me to log dinner at 8:30", timezone: 'UTC' }).expect(200);
    };
    const r1 = await propose();
    const m1 = await act(button(r1, 'memory_proposal', 'save_memory').id);
    const rem1 = await act(button(r1, 'reminder_proposal', 'create_reminder').id);
    await t.http().delete(`/v1/coach/memory/${m1.body.memory.id}`).set(h).expect(204);
    await t.http().put('/v1/reminders').set(h).send({ reminders: [], timezone: 'UTC' }).expect(200);
    // Milo proposes both again: new buttons (the app keeps done results per action id), and tapping creates them again.
    const r2 = await propose();
    expect(button(r2, 'memory_proposal', 'save_memory').id).not.toBe(button(r1, 'memory_proposal', 'save_memory').id);
    expect(button(r2, 'reminder_proposal', 'create_reminder').id).not.toBe(button(r1, 'reminder_proposal', 'create_reminder').id);
    const m2 = await act(button(r2, 'memory_proposal', 'save_memory').id);
    const rem2 = await act(button(r2, 'reminder_proposal', 'create_reminder').id);
    expect(m2.body.memory.id).not.toBe(m1.body.memory.id);
    expect(rem2.body.card.reminderId).not.toBe(rem1.body.card.reminderId);
    expect((await t.http().get('/v1/coach/memory').set(h).expect(200)).body.memories).toHaveLength(1);
    expect((await t.http().get('/v1/reminders').set(h).expect(200)).body.reminders).toHaveLength(1);
    // A third proposal while both exist creates nothing new (the target services dedupe).
    const r3 = await propose();
    expect((await act(button(r3, 'memory_proposal', 'save_memory').id)).body.memory.id).toBe(m2.body.memory.id);
    expect((await act(button(r3, 'reminder_proposal', 'create_reminder').id)).body.card.reminderId).toBe(rem2.body.card.reminderId);
  });

  it('a turn that failed after its cards were shown is retried from what it already did (no second interpret, no repeated ops)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    const date = new Date().toISOString().slice(0, 10);
    const eggs = op({ name: 'Zz test eggs', en: 'zz test eggs', qty: 2, unit: 'piece', g: 100, stated: true, n: n(155, 13, 1.1, 11) });
    const body = { text: 'I had 2 eggs, log it', clientTurnId: randomUUID(), timezone: 'UTC' };
    fake.enqueueInterpret({ intent: 'log_food', ops: [eggs], act: { type: 'log', category: 'breakfast', day: null } });
    // The reply step fails after step 2 already changed the draft and logged the meal (crash, restart, or an error).
    const spy = jest.spyOn(fake, 'streamChat').mockImplementationOnce(async () => {
      throw new ApiError('CONFLICT', 'failed after state', 409);
    });
    await turn(h, c.id, body).expect(409);
    spy.mockRestore();
    expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.meals).toHaveLength(1);
    // The retry: the model would read "add 2 eggs, log it" again against the changed draft.
    fake.enqueueInterpret({ intent: 'log_food', ops: [eggs], act: { type: 'log', category: 'breakfast', day: null } });
    fake.enqueue('Two eggs are in your breakfast.');
    const interprets = fake.calls.filter((x) => x.task === 'coach_interpret').length;
    const retry = await turn(h, c.id, body).expect(200);
    expect(fake.calls.filter((x) => x.task === 'coach_interpret').length).toBe(interprets);
    expect(retry.body.draft).toMatchObject({ version: 1, items: [{ name: 'Zz test eggs' }] });
    expect(retry.body.draft.items).toHaveLength(1);
    expect(retry.body.executed.map((x: { type: string }) => x.type)).toEqual(['log_meal']);
    expect(retry.body.reply).toBe('Two eggs are in your breakfast.');
    expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.meals).toHaveLength(1);
  });

  it('TURN_IN_PROGRESS has a message the app can show, in the request language', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    await t.get<KvStore>(KvStore).set(`turn:${c.id}`, 'another-turn', 60);
    const en = await turn(h, c.id, { text: 'hello' }).expect(409);
    expect(en.body.error).toMatchObject({ code: 'TURN_IN_PROGRESS', message: expect.stringContaining('Milo is still answering') });
    const bn = await turn(h, c.id, { text: 'hello' }).set('Accept-Language', 'bn').expect(409);
    expect(bn.body.error.message).toBe('মিলো এখনো আপনার আগের বার্তার উত্তর দিচ্ছে। একটু পরে আবার চেষ্টা করুন।');
    const sse = await t.http().post(`/v1/conversations/${c.id}/turns?stream=true`).set(h).set(INTEGRITY).set('Accept-Language', 'bn').send({ text: 'hello', inputMethod: 'typed', clientTurnId: randomUUID() }).expect(200);
    expect(sse.text).toContain('event: error');
    expect(sse.text).toContain('মিলো এখনো');
  });

  it('message history returns the newest messages when there are more than the limit', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await start(h);
    for (const text of ['one', 'two', 'three']) {
      fake.enqueueInterpret({ intent: 'chat' });
      fake.enqueue(`answer ${text}`);
      await turn(h, c.id, { text }).expect(200);
    }
    const res = await t.http().get(`/v1/conversations/${c.id}/messages?limit=2`).set(h).expect(200);
    expect(res.body.items.map((m: { text: string }) => m.text)).toEqual(['three', 'answer three']);
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
