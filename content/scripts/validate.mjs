#!/usr/bin/env node
// Validates Nouri content files. No dependencies: run with `node content/scripts/validate.mjs`.
//
// 1. questions.v*.json against questions.schema.json (small JSON Schema subset engine below).
// 2. Cross-reference checks: branching rules, exclusive IDs, routes, stages, review sections.
// 3. conversation.v*.json: turn question IDs, chip values and synonyms point at real IDs.
// 4. milo/lines.v*.json: line IDs, sentence count, banned judgemental words.
// 5. prompts/*.md: static prefix before the dynamic context marker.
// 6. Locale files <base>.<lang>.json (ADR 0007): deep parity with the English base (only the
//    allow-listed text keys may differ), placeholders, sentence limit, wording, ASCII digits.
//
// Exit code 0 when everything passes, 1 otherwise.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const ok = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---------------------------------------------------------------------------
// Minimal JSON Schema (2020-12 subset): type, enum, const, properties, required,
// additionalProperties, items, minItems, maxItems, uniqueItems, minimum, maximum,
// minLength, maxLength, pattern, minProperties, oneOf, anyOf, allOf, $ref (#/...).
// ---------------------------------------------------------------------------
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number');

function validateSchema(schema, value, rootSchema, path = '$') {
  const out = [];
  if (schema === true || schema === undefined) return out;
  if (schema === false) return [`${path}: not allowed`];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], rootSchema);
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    out.push(...validateSchema(target, value, rootSchema, path));
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) return [...out, `${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${path}: "${value}" does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${path}: items not unique`);
    if (schema.items) value.forEach((v, i) => out.push(...validateSchema(schema.items, v, rootSchema, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties != null && keys.length < schema.minProperties) out.push(`${path}: fewer than ${schema.minProperties} properties`);
    for (const r of schema.required || []) if (!(r in value)) out.push(`${path}: missing required "${r}"`);
    const props = schema.properties || {};
    for (const k of keys) {
      if (k in props) out.push(...validateSchema(props[k], value[k], rootSchema, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}: unexpected property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') out.push(...validateSchema(schema.additionalProperties, value[k], rootSchema, `${path}.${k}`));
    }
  }
  if (schema.allOf) for (const s of schema.allOf) out.push(...validateSchema(s, value, rootSchema, path));
  if (schema.anyOf && !schema.anyOf.some((s) => validateSchema(s, value, rootSchema, path).length === 0)) out.push(`${path}: matches none of anyOf`);
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validateSchema(s, value, rootSchema, path).length === 0).length;
    if (n !== 1) out.push(`${path}: matches ${n} of oneOf (expected exactly 1): ${JSON.stringify(value).slice(0, 120)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Condition walker shared by branching rules and conversation skip rules.
// ---------------------------------------------------------------------------
function checkCondition(file, where, cond, qById) {
  if (!cond || typeof cond !== 'object') return err(file, `${where}: condition is not an object`);
  if (cond.all) return cond.all.forEach((c, i) => checkCondition(file, `${where}.all[${i}]`, c, qById));
  if (cond.any) return cond.any.forEach((c, i) => checkCondition(file, `${where}.any[${i}]`, c, qById));
  if (cond.not) return checkCondition(file, `${where}.not`, cond.not, qById);
  if (cond.age || cond.route) return;
  if (!cond.q) return err(file, `${where}: unknown condition form ${JSON.stringify(cond)}`);
  const q = qById.get(cond.q);
  if (!q) return err(file, `${where}: unknown question "${cond.q}"`);
  const ids = new Set([...q.options.map((o) => o.id), ...(q.days || []).map((d) => d.id)]);
  const refs = 'eq' in cond ? [cond.eq] : 'in' in cond ? cond.in : 'includes' in cond ? [cond.includes] : 'eqSet' in cond ? cond.eqSet : [];
  for (const r of refs) if (!ids.has(r)) err(file, `${where}: option "${r}" does not exist on ${cond.q}`);
  if (('eq' in cond || 'in' in cond) && q.type !== 'single') err(file, `${where}: eq/in used on ${q.type} question ${cond.q}`);
  if (('includes' in cond || 'eqSet' in cond) && !['multi', 'days'].includes(q.type)) err(file, `${where}: includes/eqSet used on ${q.type} question ${cond.q}`);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------
const schema = readJson(join(root, 'onboarding/questions.schema.json'));
const questionFiles = readdirSync(join(root, 'onboarding')).filter((f) => /^questions\.v\d+\.json$/.test(f));
const banks = {};

for (const f of questionFiles) {
  const file = `onboarding/${f}`;
  const doc = readJson(join(root, file));
  banks[doc.version] = doc;
  const se = validateSchema(schema, doc, schema);
  se.forEach((e) => err(file, `schema ${e}`));
  if (!se.length) ok.push(`${file}: matches questions.schema.json`);
  if (`questions.v${doc.version}.json` !== f) err(file, `file name does not match version ${doc.version}`);

  const qById = new Map();
  const fieldKeys = new Set();
  for (const q of doc.questions) {
    if (qById.has(q.id)) err(file, `duplicate question id ${q.id}`);
    qById.set(q.id, q);
    if (fieldKeys.has(q.fieldKey)) err(file, `duplicate fieldKey ${q.fieldKey}`);
    fieldKeys.add(q.fieldKey);

    const optIds = q.options.map((o) => o.id);
    if (new Set(optIds).size !== optIds.length) err(file, `${q.id}: duplicate option IDs`);
    for (const x of q.exclusive) if (!optIds.includes(x)) err(file, `${q.id}: exclusive "${x}" is not an option`);
    for (const g of q.display.grid) if (!optIds.includes(g)) err(file, `${q.id}: grid "${g}" is not an option`);
    if (['single', 'multi'].includes(q.type) && optIds.length < 2) err(file, `${q.id}: ${q.type} needs at least 2 options`);
    if (q.type === 'days' && q.days.length !== 7) err(file, `${q.id}: days question needs 7 weekdays`);
    if (q.max != null && q.type !== 'multi') err(file, `${q.id}: max only applies to multi`);
    if (q.max != null && q.max >= optIds.length) warn(file, `${q.id}: max ${q.max} is not limiting`);
    if (q.type === 'text' && q.limits?.maxLength !== 50) err(file, `${q.id}: text max must be 50`);
    if (q.type === 'height' && (q.limits?.min !== 90 || q.limits?.max !== 250)) err(file, `${q.id}: height must be 90–250 cm`);
    if (q.type === 'weight' && (q.limits?.min !== 25 || q.limits?.max !== 300)) err(file, `${q.id}: weight must be 25–300 kg`);
    if (q.type === 'age' && (q.limits?.min !== 10 || q.limits?.max !== 110)) err(file, `${q.id}: age must be 10–110`);
    for (const o of q.options) if (o.input && (o.input.min < 1 || o.input.max > 365)) err(file, `${q.id}.${o.id}: custom number must stay within 1–365`);
    if (q.required && q.id !== 'q01') err(file, `${q.id}: only q01 may be required (BR-10)`);
    if (/[{]n[}]/.test(q.miloLine)) err(file, `${q.id}: use {name}, not {n}`);
  }
  const ids = [...qById.keys()];
  for (let i = 1; i <= (doc.version >= 2 ? 37 : 34); i++) { const id = `q${String(i).padStart(2, '0')}`; if (!qById.has(id)) err(file, `missing ${id}`); }
  if (doc.version >= 2) {
    // v2 never drops or retypes a v1 question or option (content README, rule 1).
    const v1 = banks[1];
    if (v1) for (const q1 of v1.questions) {
      const q2 = qById.get(q1.id);
      if (!q2) { err(file, `v2 dropped ${q1.id}`); continue; }
      if (q2.fieldKey !== q1.fieldKey || q2.type !== q1.type) err(file, `${q1.id}: fieldKey or type changed from v1`);
      for (const o of q1.options) if (!q2.options.some((x) => x.id === o.id)) err(file, `${q1.id}: v1 option ${o.id} removed`);
    }
  }
  if (!qById.has('target_weight')) err(file, 'missing target_weight (OQ-15)');
  if (!qById.get('q01')?.required) err(file, 'q01 must be required');
  doc.questions.forEach((q, i) => { if (q.order !== i + 1) err(file, `${q.id}: order ${q.order} should be ${i + 1}`); });

  // Stages cover every question exactly once and agree with question.stage
  const staged = doc.stages.flatMap((s) => s.questionIds);
  if (staged.length !== ids.length || new Set(staged).size !== ids.length) err(file, 'stages must list every question exactly once');
  for (const s of doc.stages) for (const id of s.questionIds) {
    if (!qById.has(id)) err(file, `stage ${s.id}: unknown ${id}`);
    else if (qById.get(id).stage !== s.id) err(file, `stage ${s.id}: ${id} declares stage ${qById.get(id).stage}`);
  }
  if (doc.stages[6]?.key !== 'review') err(file, 'stage 7 must be review');

  // Routes
  for (const [name, r] of Object.entries(doc.routes)) {
    for (const id of r.questionIds) if (!qById.has(id)) err(file, `route ${name}: unknown question ${id}`);
  }
  if (doc.routes.detailed.questionIds.join() !== ids.join()) err(file, 'detailed route must list every question in order');
  const basicExpected = doc.version >= 2
    ? ['q01', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11', 'q36', 'q30'] // v2: allergies are safety relevant
    : ['q01', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11', 'q30'];
  if (doc.routes.basic.questionIds.join() !== basicExpected.join()) err(file, `basic route must be ${basicExpected.join(', ')} (prototype BASIC)`);
  if (!existsSync(join(root, '..', doc.routes.conversation.ref))) err(file, `conversation ref ${doc.routes.conversation.ref} not found`);

  // Branching
  const shown = new Set();
  for (const rule of doc.branching) {
    if (!qById.has(rule.show)) err(file, `${rule.id}: show "${rule.show}" is not a question`);
    if (shown.has(rule.show)) err(file, `${rule.id}: more than one rule for ${rule.show}`);
    shown.add(rule.show);
    checkCondition(file, rule.id, rule.when, qById);
    for (const c of rule.onHide.clear) if (!qById.has(c)) err(file, `${rule.id}: clear "${c}" is not a question`);
    // A rule may only depend on questions asked earlier in the detailed order (no forward references).
    const deps = JSON.stringify(rule.when).match(/"q":"([^"]+)"/g)?.map((m) => m.slice(5, -1)) || [];
    for (const d of deps) if (qById.get(d) && qById.get(rule.show) && qById.get(d).order >= qById.get(rule.show).order) err(file, `${rule.id}: depends on later question ${d}`);
  }
  const expectedRules = ['q07', 'q08', 'q09', 'q10', 'target_weight', 'q16', 'q19', 'q27', 'q31', ...(doc.version >= 2 ? ['q35'] : [])];
  for (const e of expectedRules) if (!shown.has(e)) err(file, `missing branching rule for ${e}`);
  for (const s of shown) if (!expectedRules.includes(s)) err(file, `unexpected branching rule for ${s}`);

  // Review sections cover every question once
  const sec = doc.reviewSections.flatMap((s) => s.questionIds);
  for (const id of sec) if (!qById.has(id)) err(file, `reviewSections: unknown ${id}`);
  if (sec.length !== ids.length || new Set(sec).size !== ids.length) err(file, 'reviewSections must list every question exactly once');

  // Behavioural spot checks: evaluate the rules with a reference engine
  const engineErrors = runEngineFixtures(doc, qById);
  engineErrors.forEach((e) => err(file, `engine fixture: ${e}`));
  if (!engineErrors.length) ok.push(`${file}: ${fixtures().length} branching fixtures match prototype applicable()`);
  ok.push(`${file}: ${ids.length} questions, ${doc.branching.length} branching rules, cross-references OK`);
}

// Reference evaluator (mirrors the grammar in conditionGrammar) used only for fixtures.
function ageOf(a) {
  const v = a.q06; if (!v) return null;
  if (v.mode === 'age') return v.age;
  if (v.mode === 'dob' && v.dob) { const d = new Date(v.dob), n = new Date(); let y = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) y--; return y; }
  return null;
}
function evalCond(c, a, route) {
  if (c.all) return c.all.every((x) => evalCond(x, a, route));
  if (c.any) return c.any.some((x) => evalCond(x, a, route));
  if (c.not) return !evalCond(c.not, a, route);
  if (c.age) { const g = ageOf(a); if (g == null) return false; return (c.age.gte == null || g >= c.age.gte) && (c.age.gt == null || g > c.age.gt) && (c.age.lte == null || g <= c.age.lte) && (c.age.lt == null || g < c.age.lt); }
  if (c.route) return typeof c.route === 'string' ? route === c.route : c.route.in.includes(route);
  const v = a[c.q];
  const has = v != null && v !== '' && !(Array.isArray(v) && !v.length);
  if ('answered' in c) return has === c.answered;
  if (!has) return false;
  if ('eq' in c) return v === c.eq;
  if ('in' in c) return c.in.includes(v);
  if ('includes' in c) return Array.isArray(v) && v.includes(c.includes);
  if ('eqSet' in c) return Array.isArray(v) && v.length === c.eqSet.length && c.eqSet.every((x) => v.includes(x));
  return false;
}
function applicable(doc, a, route) {
  const list = doc.routes[route].questionIds;
  return list.filter((id) => doc.branching.filter((r) => r.show === id).every((r) => evalCond(r.when, a, route)));
}
function fixtures() { return [
  { name: 'empty answers, detailed', route: 'detailed', a: {}, hidden: ['q07', 'q08', 'q09', 'q10', 'target_weight', 'q16', 'q19', 'q27', 'q31'] },
  { name: 'under 18 skips q07–q10', route: 'detailed', a: { q01: 'lose', q06: { mode: 'age', age: 16 }, q07: 'female', q08: { cm: 160 }, q09: { kg: 50 } }, hidden: ['q07', 'q08', 'q09', 'q10', 'target_weight'] },
  { name: 'age declined skips q07–q10', route: 'detailed', a: { q06: { mode: 'none' } }, hidden: ['q07', 'q08'] },
  { name: 'adult shows q07 only', route: 'detailed', a: { q06: { mode: 'age', age: 28 } }, shown: ['q07'], hidden: ['q08'] },
  { name: 'adult unsure sex input', route: 'detailed', a: { q06: { mode: 'age', age: 28 }, q07: 'unsure' }, shown: ['q07'], hidden: ['q08', 'q09', 'q10'] },
  { name: 'adult full chain', route: 'detailed', a: { q01: 'lose', q06: { mode: 'age', age: 28 }, q07: 'male', q08: { cm: 172 }, q09: { kg: 78 } }, shown: ['q08', 'q09', 'q10', 'target_weight'] },
  { name: 'height skipped hides q09, q10', route: 'detailed', a: { q06: { mode: 'age', age: 30 }, q07: 'female' }, shown: ['q08'], hidden: ['q09', 'q10'] },
  { name: 'maintain hides target weight', route: 'detailed', a: { q01: 'maintain', q06: { mode: 'age', age: 28 }, q07: 'male', q08: { cm: 172 }, q09: { kg: 78 } }, hidden: ['target_weight'] },
  { name: 'q15 varies shows q16', route: 'detailed', a: { q15: 'varies' }, shown: ['q16'] },
  { name: 'q15 no hides q16', route: 'detailed', a: { q15: 'no' }, hidden: ['q16'] },
  { name: 'q04 fasting shows q19', route: 'detailed', a: { q04: ['logging', 'fasting'] }, shown: ['q19'] },
  { name: 'q21 movement shows q27', route: 'detailed', a: { q21: ['movement'] }, shown: ['q27'] },
  { name: 'q04 movement shows q27', route: 'detailed', a: { q04: ['movement'] }, shown: ['q27'] },
  { name: 'q30 manual only shows q31', route: 'detailed', a: { q30: ['manual'] }, shown: ['q31'] },
  { name: 'q30 manual + photo hides q31', route: 'detailed', a: { q30: ['manual', 'photo'] }, hidden: ['q31'] },
  { name: 'basic route never shows q31', route: 'basic', a: { q30: ['manual'] }, hidden: ['q31'] },
  { name: 'basic adult chain', route: 'basic', a: { q06: { mode: 'age', age: 40 }, q07: 'female', q08: { cm: 165 }, q09: { kg: 70 } }, shown: ['q07', 'q08', 'q09', 'q10'] }
]; }
function runEngineFixtures(doc) {
  const out = [];
  for (const f of fixtures()) {
    const list = applicable(doc, f.a, f.route);
    for (const s of f.shown || []) if (!list.includes(s)) out.push(`${f.name}: expected ${s} shown`);
    for (const h of f.hidden || []) if (list.includes(h)) out.push(`${f.name}: expected ${h} hidden`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
for (const f of readdirSync(join(root, 'onboarding')).filter((x) => /^conversation\.v\d+\.json$/.test(x))) {
  const file = `onboarding/${f}`;
  const doc = readJson(join(root, file));
  const bank = banks[doc.questionSetVersion];
  if (!bank) { err(file, `questionSetVersion ${doc.questionSetVersion} has no questions file`); continue; }
  const qById = new Map(bank.questions.map((q) => [q.id, q]));
  const optOk = (qid, oid) => qById.get(qid)?.options.some((o) => o.id === oid);
  if (doc.turns.length !== 9) err(file, `expected 9 turn groups, found ${doc.turns.length}`);
  doc.turns.forEach((t, i) => {
    if (t.turn !== i + 1) err(file, `turn ${t.turn} out of order`);
    for (const id of t.questionIds) if (!qById.has(id)) err(file, `turn ${t.turn}: unknown question ${id}`);
    for (const [id] of Object.entries(t.askOne || {})) if (!t.questionIds.includes(id)) err(file, `turn ${t.turn}: askOne for ${id} not in group`);
    for (const c of t.chips || []) {
      for (const [qid, v] of Object.entries(c.sets || {})) {
        if (!qById.has(qid)) err(file, `turn ${t.turn} chip "${c.label}": unknown question ${qid}`);
        else if (typeof v === 'string' && !optOk(qid, v)) err(file, `turn ${t.turn} chip "${c.label}": ${qid} has no option ${v}`);
      }
      for (const qid of c.skips || []) if (!qById.has(qid)) err(file, `turn ${t.turn} chip "${c.label}": unknown skip ${qid}`);
    }
    if (t.skipWhen) checkCondition(file, `turn ${t.turn}.skipWhen`, t.skipWhen, qById);
    for (const id of t.provisional || []) if (!t.questionIds.includes(id)) err(file, `turn ${t.turn}: provisional ${id} not in group`);
    if (sentences(t.miloLine) > 3) err(file, `turn ${t.turn}: miloLine longer than 3 sentences`);
  });
  const convIds = doc.turns.flatMap((t) => t.questionIds);
  if (convIds.join() !== bank.routes.conversation.questionIds.join()) err(file, 'turn question IDs must match routes.conversation.questionIds in the question bank');
  for (const [qid, opts] of Object.entries(doc.synonyms)) {
    if (!qById.has(qid)) { err(file, `synonyms: unknown question ${qid}`); continue; }
    for (const [oid, phrases] of Object.entries(opts)) {
      if (!optOk(qid, oid)) err(file, `synonyms: ${qid} has no option ${oid}`);
      if (!Array.isArray(phrases) || !phrases.length) err(file, `synonyms: ${qid}.${oid} needs phrases`);
    }
  }
  for (const [qid, m] of Object.entries(doc.chipLabels || {})) for (const oid of Object.keys(m)) if (!optOk(qid, oid)) err(file, `chipLabels: ${qid} has no option ${oid}`);
  if (!doc.final?.text) err(file, 'missing final line');
  ok.push(`${file}: ${doc.turns.length} turns, synonyms for ${Object.keys(doc.synonyms).length} questions, references OK`);
}

// ---------------------------------------------------------------------------
// Milo lines
// ---------------------------------------------------------------------------
function sentences(t) { return (t.replace(/\b(e\.g|i\.e|approx)\./g, '').match(/[.!?…](\s|$)/g) || []).length || 1; }
const BANNED = /\b(good food|bad food|junk|cheat( meal| day)?|guilt[- ]free|naughty|sinful|clean eating|unhealthy food|you should be ashamed|failed|failure)\b/i;
for (const f of existsSync(join(root, 'milo')) ? readdirSync(join(root, 'milo')).filter((x) => /^lines\.v\d+\.json$/.test(x)) : []) {
  const file = `milo/${f}`;
  const doc = readJson(join(root, file));
  let n = 0;
  const seen = new Set();
  const walk = (id, line) => {
    n++;
    if (seen.has(id)) err(file, `duplicate line id ${id}`);
    seen.add(id);
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/.test(id)) err(file, `bad line id ${id}`);
    for (const k of ['text', 'title', 'sub']) {
      if (line[k] == null) continue;
      if (BANNED.test(line[k])) err(file, `${id}.${k}: judgemental wording "${line[k]}"`);
      if (sentences(line[k]) > 3) err(file, `${id}.${k}: more than 3 sentences`);
      if (/\b(color|center|analyze|personalize|recognize|favorite|program)\b/i.test(line[k])) err(file, `${id}.${k}: US spelling`);
    }
    if (line.text == null && line.title == null) err(file, `${id}: needs text or title`);
  };
  for (const [id, line] of Object.entries(doc.lines)) walk(id, line);
  for (const [cat, set] of Object.entries(doc.scanReactions.categories)) {
    if (set.variants.length !== 3) err(file, `scanReactions.${cat}: needs exactly 3 variants`);
    set.variants.forEach((v) => walk(v.id, v));
  }
  for (const nd of doc.nudges.items) walk(nd.id, nd);
  for (const [trig, p] of Object.entries(doc.paywall.triggers)) {
    if (!['onboarding', 'upgrade', 'limit'].includes(trig.split('.')[0])) err(file, `paywall trigger ${trig} is not onboarding|upgrade|limit`);
    walk(`paywall.${trig}`, p);
  }
  for (const m of doc.degraded.items) walk(m.id, m);
  ok.push(`${file}: ${n} lines checked (ids, ≤3 sentences, tone, UK spelling)`);
  // Coach quick actions (coach.quickActions): templates, habits-only and degraded variants.
  const coach = doc.coach;
  const NUMERIC = /\bkcal\b|\{\w*(Kcal|G)\}|\b\d+\s?g\b/;
  if (!coach?.quickActions) err(file, 'missing coach.quickActions');
  else {
    const allowed = new Set(Object.keys(coach.placeholders || {}));
    const placeholdersOk = (id, t) => { for (const m of t.matchAll(/\{(\w+)\}/g)) if (!allowed.has(m[1])) err(file, `${id}: placeholder {${m[1]}} not declared in coach.placeholders`); };
    const actions = Object.keys(coach.quickActions);
    if (actions.sort().join() !== ['explain_macros', 'review_day', 'suggest_snack'].join()) err(file, `coach.quickActions must be explain_macros, review_day, suggest_snack (got ${actions.join(', ')})`);
    for (const [action, qa] of Object.entries(coach.quickActions)) {
      if (!doc.lines[qa.labelLineId]) err(file, `coach.quickActions.${action}: labelLineId ${qa.labelLineId} not in lines`);
      if (!['template', 'model'].includes(qa.kind)) err(file, `coach.quickActions.${action}: kind must be template|model`);
      const vs = [...(qa.variants || []), ...(qa.suffixes || [])];
      if (!(qa.variants || []).length) err(file, `coach.quickActions.${action}: needs variants`);
      if (!qa.variants?.some((v) => /^habitsOnly/.test(v.when))) err(file, `coach.quickActions.${action}: needs a habits-only variant`);
      if (!qa.variants?.some((v) => v.when === 'full')) err(file, `coach.quickActions.${action}: needs an unconditional full variant`);
      const last = qa.variants?.[qa.variants.length - 1];
      if (last && last.when !== 'full') err(file, `coach.quickActions.${action}: last variant must be the "full" fallback`);
      for (const v of vs) {
        if (!v.id.startsWith(`coach.qa.${action}.`)) err(file, `${v.id}: id must start with coach.qa.${action}.`);
        if (!v.when) err(file, `${v.id}: needs when`);
        walk(v.id, v);
        placeholdersOk(v.id, v.text);
        if (/^habitsOnly/.test(v.when) && NUMERIC.test(v.text)) err(file, `${v.id}: habits-only variant contains calorie or macro numbers`);
      }
    }
    for (const [id, line] of Object.entries(coach.fragments || {})) { walk(id, line); placeholdersOk(id, line.text); }
    const deg = coach.degraded?.items || [];
    for (const k of ['caption', 'captionHabits', 'chat', 'apiMessage']) if (!deg.some((d) => d.id === `coach.qa.degraded.${k}`)) err(file, `coach.degraded missing coach.qa.degraded.${k}`);
    for (const d of deg) { walk(d.id, d); if (!/Milo is resting/.test(`${d.title || ''} ${d.text}`)) err(file, `${d.id}: degraded copy should say "Milo is resting"`); if (/Habits/.test(d.id) && NUMERIC.test(d.text)) err(file, `${d.id}: habits caption mentions numbers`); }
    ok.push(`${file}: coach.quickActions OK (${actions.length} actions, habits-only and degraded variants)`);
  }

  // Eligibility step (OQ-30) and camera permission explainer.
  for (const k of ['title', 'sub', 'pregnantOrBreastfeeding', 'supervisedNutritionCondition', 'yes', 'no', 'continue', 'why', 'habitsOnly', 'habitsOnlyMilo', ...(doc.version >= 2 ? ['eatingConcern'] : [])])
    if (!doc.lines[`eligibility.${k}`]) err(file, `missing line eligibility.${k}`);
  if (doc.version >= 2 && !doc.eligibility?.mapsTo?.includes('eatingDisorderConcern')) err(file, 'eligibility.mapsTo must name eatingDisorderConcern (v2)');
  if (NUMERIC.test(doc.lines['eligibility.habitsOnly']?.text || '')) err(file, 'eligibility.habitsOnly must not mention numbers');
  if (!doc.eligibility?.mapsTo?.includes('pregnantOrBreastfeeding') || !doc.eligibility?.mapsTo?.includes('supervisedNutritionCondition')) err(file, 'eligibility.mapsTo must name both attestation fields');
  for (const k of ['', '.allow', '.notNow', '.denied', '.openSettings', '.describeInstead'])
    if (!doc.lines[`permission.camera${k}`]) err(file, `missing line permission.camera${k}`);
  ok.push(`${file}: eligibility step and camera permission copy present`);

}

// ---------------------------------------------------------------------------
// Locale files: <base>.<lang>.json next to the English base (ADR 0007).
// The English file owns structure; a translation may only change the text keys
// listed in the policy functions below. Everything else must be identical.
// ---------------------------------------------------------------------------
const LOCALE_KINDS = {
  questions: { dir: 'onboarding', re: /^questions\.v(\d+)\.([a-z]{2,3})\.json$/, base: (v) => `questions.v${v}.json` },
  conversation: { dir: 'onboarding', re: /^conversation\.v(\d+)\.([a-z]{2,3})\.json$/, base: (v) => `conversation.v${v}.json` },
  lines: { dir: 'milo', re: /^lines\.v(\d+)\.([a-z]{2,3})\.json$/, base: (v) => `lines.v${v}.json` }
};

// Per-language rule packs. A language without a pack still gets every structural check
// (parity, placeholders, sentence count, non-empty); script and wording checks are skipped with a warning.
const LANG_PACKS = {
  bn: {
    script: /[ঀ-৿]/,
    digits: /[০-৯]/, // Bengali digits are not allowed in content files; the app localises digits
    banned: /(ভালো খাবার|ভাল খাবার|খারাপ খাবার|মন্দ খাবার|চিট ?ডে|চিট ?মিল|চিট-ডে|জাঙ্ক|জাংক|গিল্ট|গিল্টি|দোষী|লজ্জা|লজ্জিত|ব্যর্থ|ব্যর্থতা|দুষ্টু|ক্লিন ইটিং|অস্বাস্থ্যকর খাবার|অপরাধবোধমুক্ত|(?<![ঀ-৿])পাপ(?![ঀ-৿])|পাপী)/,
    abbreviations: /(মি\.লি\.|সে\.মি\.|কে\.জি\.|মি\.)/g,
    numeric: /[\d}]\s?(ক্যালরি|কিলোক্যালরি|গ্রাম|কেজি)/, // calorie or macro figures (habits-only copy must not have them)
    resting: /মিলো[^।]*বিশ্রাম|বিশ্রাম[^।]*মিলো/ // coach degraded copy must say Milo is resting
  }
};

const ALLOWED_LATIN = new Set(['nouri', 'plus', 'mifflin', 'st', 'jeor', 'app', 'store', 'google', 'play', 'kcal', 'ml', 'g', 'kg', 'cm', 'ft', 'in', 'lb', 'lbs', 'm']);
const PLACEHOLDER_RE = /\{\{[^}]+\}\}|\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const placeholderSet = (t) => [...new Set(t.match(PLACEHOLDER_RE) || [])].sort().join(' ');
const pathStr = (p) => p.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('');
const LOC_NUMERIC_EN = /\bkcal\b|\{\w*(Kcal|G)\}|\b\d+\s?g\b/;

function locSentences(t, pack) {
  const s = (pack?.abbreviations ? t.replace(pack.abbreviations, 'x') : t).replace(/\b(e\.g|i\.e|approx)\./g, '');
  return (s.match(/[।.?!…]+(?=\s|$|["”’)\]])/g) || []).length || 1;
}

// Which paths carry translatable copy. Returns 'locale' | 'text' | 'hint' | 'list' | 'add' | null (null = must be identical).
const QUESTION_TEXT = new Set(['text', 'note', 'miloLine', 'miloLineNoName', 'reviewLabel', 'skipLabel']);
const REVIEW_COPY = new Set(['title', 'note', 'notProvided', 'primaryAction', 'editAll', 'answerRest']); // review.rowRule is documentation
const POLICIES = {
  questions(p) {
    const [a, b, c, d, e] = p;
    if (p.length === 1 && a === 'locale') return 'locale';
    if (a === 'stages' && p.length === 3 && c === 'label') return 'text';
    if (a === 'routes' && p.length === 3 && (c === 'label' || c === 'sub')) return 'text';
    if (a === 'reviewSections' && p.length === 3 && c === 'label') return 'text';
    if (a === 'review' && p.length === 2 && REVIEW_COPY.has(b)) return 'text';
    if (a === 'questions') {
      if (p.length === 3 && c === 'hint') return 'hint';
      if (p.length === 3 && QUESTION_TEXT.has(c)) return 'text';
      if (p.length === 5 && c === 'options' && (e === 'label' || e === 'shortLabel')) return 'text';
      if (p.length === 5 && c === 'days' && (e === 'short' || e === 'label')) return 'text';
    }
    return null;
  },
  conversation(p, v) {
    const [a, b, c, d, e] = p;
    if (p.length === 1 && a === 'locale') return 'locale';
    if (a === 'confirm' && p.length === 2 && ['template', 'summaryItem', 'summaryJoiner', 'onChange'].includes(b)) return 'text';
    if (a === 'confirm' && b === 'chips' && p.length === 4 && d === 'label') return 'text';
    if (a === 'skipToPlan' && p.length === 2 && b === 'label') return 'text';
    if (a === 'turns' && p.length === 3 && ['stageLabel', 'miloLine', 'ackAfter'].includes(c)) return 'text';
    if (a === 'turns' && p.length === 4 && c === 'askOne') return 'text';
    if (a === 'turns' && p.length === 5 && c === 'chips' && e === 'label') return 'text';
    if (a === 'final' && p.length === 2 && ['text', 'textNoName', 'habitsOnly', 'habitsOnlyNoName'].includes(b)) return 'text';
    if (a === 'fallbackAcks' && p.length === 2) return 'text';
    if (a === 'chipLabels' && p.length === 3) return 'text';
    if (a === 'synonyms' && p.length === 3) return 'list';
    if (a === 'phrases' && p.length === 2) return 'list';
    if (a === 'units' && p.length === 3 && Array.isArray(v)) return 'list';
    return null;
  },
  lines(p) {
    const [a, b, c, d, e, f] = p;
    if (p.length === 1 && a === 'locale') return 'locale';
    if (a === 'lines' && p.length === 3 && ['text', 'title', 'sub'].includes(c)) return 'text';
    if (a === 'scanReactions' && b === 'keywords' && p.length === 3) return 'add';
    if (a === 'scanReactions' && b === 'categories' && p.length === 6 && d === 'variants' && ['title', 'text'].includes(f)) return 'text';
    if (a === 'nudges' && b === 'items' && p.length === 4 && ['title', 'sub', 'subNoPhoto', 'subHabits', 'subIfBusy'].includes(d)) return 'text';
    if (a === 'paywall' && b === 'triggers' && p.length === 4 && ['title', 'sub'].includes(d)) return 'text';
    if (a === 'degraded' && b === 'items' && p.length === 4 && ['title', 'text'].includes(d)) return 'text';
    if (a === 'degraded' && b === 'items' && p.length === 5 && d === 'actions') return 'text';
    if (a === 'coach' && b === 'quickActions' && p.length === 6 && ['variants', 'suffixes'].includes(d) && f === 'text') return 'text';
    if (a === 'coach' && b === 'fragments' && p.length === 4 && d === 'text') return 'text';
    if (a === 'coach' && b === 'degraded' && c === 'items' && p.length === 5 && ['title', 'text'].includes(e)) return 'text';
    return null;
  }
};

function checkLocaleFile(kind, lang, file, enDoc, doc, rawText) {
  const pack = LANG_PACKS[lang];
  const stats = { strings: 0, lists: 0 };
  const hintMap = new Map(); // English hint -> translated hint
  const fail = (msg) => err(file, msg);

  if (!pack) warn(file, `no rule pack for "${lang}" in LANG_PACKS: structural checks only (script, wording and digit checks skipped)`);
  if (pack?.digits.test(rawText)) fail(`contains non-ASCII digits (${rawText.match(pack.digits)[0]}…): content files use ASCII digits only, the app localises digits`);

  const wordingChecks = (p, bn) => {
    if (pack?.banned.test(bn) || BANNED.test(bn)) fail(`${pathStr(p)}: judgemental wording in "${bn}"`);
  };

  function checkText(p, en, bn) {
    const where = pathStr(p);
    stats.strings++;
    if (typeof bn !== 'string' || !bn.trim()) return fail(`${where}: empty translation`);
    if (placeholderSet(en) !== placeholderSet(bn)) fail(`${where}: placeholders differ (English "${placeholderSet(en)}", translation "${placeholderSet(bn)}")`);
    if (locSentences(bn, pack) > 3) fail(`${where}: more than 3 sentences`);
    wordingChecks(p, bn);
    if (!pack) return;
    const bare = bn.replace(PLACEHOLDER_RE, ' ');
    const latin = (bare.match(/[A-Za-z][A-Za-z'’]*/g) || []);
    if (pack.script.test(bn)) {
      const stray = latin.filter((w) => !ALLOWED_LATIN.has(w.toLowerCase()));
      if (stray.length) warn(file, `${where}: Latin words left in translation: ${[...new Set(stray)].join(', ')}`);
    } else if (latin.length) {
      if (latin.every((w) => ALLOWED_LATIN.has(w.toLowerCase()))) warn(file, `${where}: no ${lang} characters, only brand or unit text ("${bn}")`);
      else fail(`${where}: not translated, no ${lang} characters in "${bn}"`);
    } // no letters at all (placeholders, numbers, punctuation): nothing to translate
  }

  function checkList(p, en, bn, mode) {
    const where = pathStr(p);
    stats.lists++;
    if (!Array.isArray(bn) || !bn.length) return fail(`${where}: needs at least one phrase`);
    const seen = new Set();
    bn.forEach((ph, i) => {
      if (typeof ph !== 'string' || !ph.trim()) return fail(`${where}[${i}]: empty phrase`);
      if (ph !== ph.trim()) fail(`${where}[${i}]: phrase has leading or trailing spaces ("${ph}")`);
      if (seen.has(ph)) fail(`${where}[${i}]: duplicate phrase "${ph}"`);
      seen.add(ph);
      if (mode === 'add' && en.includes(ph)) return; // the English keyword stays as it is
      wordingChecks([...p, i], ph);
      if (pack && !pack.script.test(ph)) {
        const latin = ph.match(/[A-Za-z]+/g) || [];
        if (latin.length && latin.every((w) => ALLOWED_LATIN.has(w.toLowerCase()))) warn(file, `${where}[${i}]: no ${lang} characters, only unit text ("${ph}")`);
        else if (latin.length || mode === 'add') fail(`${where}[${i}]: phrase has no ${lang} characters ("${ph}")`);
      }
    });
    if (mode === 'add') {
      for (const k of en) if (!bn.includes(k)) fail(`${where}: English keyword "${k}" removed (translations may only add keywords)`);
      if (bn.length <= en.length) fail(`${where}: no ${lang} keywords added`);
    }
  }

  function walkCmp(enV, bnV, p) {
    const pol = POLICIES[kind](p, enV);
    const te = typeOf(enV), tb = typeOf(bnV);
    if (te !== tb && !(te === 'integer' && tb === 'number') && !(te === 'number' && tb === 'integer')) return fail(`${pathStr(p)}: type differs from English (${te} vs ${tb})`);
    if (pol === 'locale') {
      if (bnV !== lang) fail(`locale must be "${lang}" (got "${bnV}")`);
      return;
    }
    if (pol === 'text' || pol === 'hint') {
      if (te === 'null') return;
      if (te !== 'string') return fail(`${pathStr(p)}: expected a string`);
      checkText(p, enV, bnV);
      if (pol === 'hint' && typeof bnV === 'string') {
        if (hintMap.has(enV) && hintMap.get(enV) !== bnV) fail(`${pathStr(p)}: hint "${enV}" is translated two ways ("${hintMap.get(enV)}" and "${bnV}")`);
        hintMap.set(enV, bnV);
      }
      return;
    }
    if (pol === 'list' || pol === 'add') {
      if (te !== 'array') return fail(`${pathStr(p)}: expected an array of phrases`);
      return checkList(p, enV, bnV, pol);
    }
    if (te === 'array') {
      if (enV.length !== bnV.length) return fail(`${pathStr(p)}: length ${bnV.length}, English has ${enV.length}`);
      return enV.forEach((x, i) => walkCmp(x, bnV[i], [...p, i]));
    }
    if (te === 'object') {
      const ek = Object.keys(enV), bk = Object.keys(bnV);
      for (const k of ek) if (!(k in bnV)) fail(`${pathStr([...p, k])}: missing (present in English)`);
      for (const k of bk) if (!(k in enV)) fail(`${pathStr([...p, k])}: not in the English file`);
      if (ek.length === bk.length && ek.every((k) => k in bnV) && ek.join('\u0000') !== bk.join('\u0000')) fail(`${pathStr(p) || '$'}: key order differs from English`);
      return ek.forEach((k) => { if (k in bnV) walkCmp(enV[k], bnV[k], [...p, k]); });
    }
    if (enV !== bnV) fail(`${pathStr(p)}: non-text value changed (English ${JSON.stringify(enV)}, translation ${JSON.stringify(bnV)})`);
  }

  walkCmp(enDoc, doc, []);

  // Same English hint -> same translated hint, and two different hints never share a translation.
  const back = new Map();
  for (const [e, b] of hintMap) { if (back.has(b)) fail(`hints "${back.get(b)}" and "${e}" share the translation "${b}"`); back.set(b, e); }
  return stats;
}

const localeOk = [];
for (const [kind, spec] of Object.entries(LOCALE_KINDS)) {
  const dir = join(root, spec.dir);
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => spec.re.test(x)).sort() : []) {
    const [, ver, lang] = f.match(spec.re);
    const file = `${spec.dir}/${f}`;
    const baseName = spec.base(ver);
    if (!existsSync(join(dir, baseName))) { err(file, `English base ${spec.dir}/${baseName} not found (a translation needs the English file with the same version)`); continue; }
    let doc, enDoc, raw;
    try { raw = readFileSync(join(dir, f), 'utf8'); doc = JSON.parse(raw); } catch (e) { err(file, `invalid JSON: ${e.message}`); continue; }
    enDoc = readJson(join(dir, baseName));
    const before = errors.length;

    if (doc.version !== enDoc.version) err(file, `version ${doc.version} differs from ${baseName} (${enDoc.version})`);
    if (String(doc.version) !== ver) err(file, `file name says v${ver} but version is ${doc.version}`);
    if (kind === 'questions') {
      // Same schema, with the two language-dependent fields relaxed: locale (any language code) and hint (any non-empty string).
      const relaxed = JSON.parse(JSON.stringify(schema));
      relaxed.properties.locale = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' };
      relaxed.$defs.question.properties.hint = { type: 'string', minLength: 1 };
      validateSchema(relaxed, doc, relaxed).forEach((e) => err(file, `schema ${e}`));
    }
    const stats = checkLocaleFile(kind, lang, file, enDoc, doc, raw);

    if (kind === 'conversation') {
      // A chip that repeats an option label in English must repeat it in the translation too.
      doc.turns.forEach((t, i) => (t.chips || []).forEach((c, j) => {
        for (const [qid, v] of Object.entries(c.sets || {})) {
          if (typeof v === 'string') { const en = enDoc.chipLabels?.[qid]?.[v]; if (en === enDoc.turns[i].chips[j].label && doc.chipLabels?.[qid]?.[v] !== c.label) err(file, `turn ${t.turn} chip "${c.label}" differs from chipLabels.${qid}.${v} ("${doc.chipLabels?.[qid]?.[v]}")`); }
          else if (Array.isArray(v) && v.length === 1) { const en = enDoc.chipLabels?.[qid]?.[v[0]]; if (en === enDoc.turns[i].chips[j].label && doc.chipLabels?.[qid]?.[v[0]] !== c.label) err(file, `turn ${t.turn} chip "${c.label}" differs from chipLabels.${qid}.${v[0]} ("${doc.chipLabels?.[qid]?.[v[0]]}")`); }
        }
      }));
      for (const [qid, opts] of Object.entries(doc.synonyms || {})) for (const [oid, phrases] of Object.entries(opts)) if (!Array.isArray(phrases) || !phrases.length) err(file, `synonyms.${qid}.${oid}: needs at least one phrase`);
      if (!doc.final?.text) err(file, 'missing final line');
    }

    if (kind === 'lines') {
      const pack = LANG_PACKS[lang];
      const numeric = (t) => LOC_NUMERIC_EN.test(t) || !!pack?.numeric.test(t);
      for (const k of ['title', 'sub', 'pregnantOrBreastfeeding', 'supervisedNutritionCondition', 'yes', 'no', 'continue', 'why', 'habitsOnly', 'habitsOnlyMilo', ...(doc.version >= 2 ? ['eatingConcern'] : [])])
        if (!doc.lines?.[`eligibility.${k}`]) err(file, `missing line eligibility.${k}`);
      for (const k of ['', '.allow', '.notNow', '.denied', '.openSettings', '.describeInstead'])
        if (!doc.lines?.[`permission.camera${k}`]) err(file, `missing line permission.camera${k}`);
      if (numeric(doc.lines?.['eligibility.habitsOnly']?.text || '')) err(file, 'eligibility.habitsOnly must not mention numbers');
      for (const [action, qa] of Object.entries(doc.coach?.quickActions || {}))
        for (const v of qa.variants || []) if (/^habitsOnly/.test(v.when) && numeric(v.text)) err(file, `${v.id}: habits-only variant contains calorie or macro numbers`);
      if (pack) for (const d of doc.coach?.degraded?.items || []) {
        if (!pack.resting.test(`${d.title || ''} ${d.text}`)) err(file, `${d.id}: degraded copy should say Milo is resting`);
        if (/Habits/.test(d.id) && numeric(d.text)) err(file, `${d.id}: habits caption mentions numbers`);
      }
    }

    if (errors.length === before) localeOk.push(`${file}: matches ${baseName} (${stats.strings} strings${stats.lists ? `, ${stats.lists} phrase lists` : ''}; placeholders, sentence limit, wording, digits OK)`);
  }
}
ok.push(...localeOk);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const MARK = '<!-- DYNAMIC CONTEXT BELOW: not cached -->';
const promptDir = join(root, 'prompts');
for (const f of existsSync(promptDir) ? readdirSync(promptDir).filter((x) => x.endsWith('.md')) : []) {
  const file = `prompts/${f}`;
  const t = readFileSync(join(promptDir, f), 'utf8');
  if (!/^---\n(?:[\s\S]*?\n)?key: [a-z-]+\n[\s\S]*?\n---\n/.test(t)) err(file, 'missing front matter with key');
  const inc = (t.match(/^includes: \[([^\]]*)\]/m)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const x of inc) {
    if (!existsSync(join(promptDir, `${x}.md`))) err(file, `include ${x}.md not found`);
    if (!t.includes(`[[include ${x}]]`)) err(file, `declares include ${x} but has no [[include ${x}]] marker`);
  }
  const i = t.indexOf(MARK);
  if (f.startsWith('safety-rules')) { if (i >= 0) err(file, 'shared include must not have a dynamic section'); ok.push(`${file}: include OK`); continue; }
  if (i < 0) { err(file, 'missing dynamic context marker'); continue; }
  if (t.indexOf(MARK, i + 1) >= 0) err(file, 'dynamic marker appears twice');
  const stat = t.slice(0, i);
  if (/\{\{[^}]+\}\}/.test(stat)) err(file, 'static prefix contains {{placeholders}} (breaks prompt caching)');
  if (!/# Static prefix/.test(stat)) err(file, 'missing "# Static prefix" heading');
  const blocks = [...stat.matchAll(/```json\n([\s\S]*?)```/g)];
  for (const b of blocks) { try { JSON.parse(b[1]); } catch (e) { err(file, `invalid JSON block: ${e.message}`); } }
  if (!blocks.length) err(file, 'no JSON output schema in static prefix');
  ok.push(`${file}: static prefix first, ${blocks.length} JSON block(s) parse`);
}

// ---------------------------------------------------------------------------
for (const o of ok) console.log(`ok    ${o}`);
for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`FAIL  ${e}`);
console.log(`\n${errors.length ? 'FAILED' : 'PASSED'}: ${ok.length} checks ok, ${warnings.length} warnings, ${errors.length} errors`);
process.exit(errors.length ? 1 : 0);
