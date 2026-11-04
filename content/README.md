# Nouri content

Product-owned content that drives onboarding, Milo's copy and the AI prompts. The backend seeds it into `content_versions` and `ai_prompts`, serves it through `GET /onboarding/questions` and `GET /content/*` (ETag, CDN-cached, keyed by version), and the admin panel edits later versions. Plan reference: `../nouri-docs/PLAN.md` §8, §10, §11.

Owner: product. Only product edits files here; other projects request changes in `../nouri-docs/handoff/`.

## Files

| File | What it is | Consumed by |
|---|---|---|
| `onboarding/questions.v1.json` | The question bank: 34 questions plus optional `target_weight`, field keys, option IDs, types, limits, Milo lines, hints, stages, routes (basic, detailed, conversation), declarative branching rules, review sections and copy, value formats | nouri-backend `domain/onboarding-engine` (TypeScript), validation of `PUT /onboarding/answers`; nouri-mobile local engine (Dart) for local-first setup (DEC-18) via the API; nouri-frontend admin content editor |
| `onboarding/questions.schema.json` | JSON Schema (2020-12) for the question bank | Validator, admin editor, CI |
| `onboarding/conversation.v1.json` | The conversation subset: 9 turn groups, canonical Milo lines, `askOne` follow-ups, chips with direct answers, skip conditions, provisional handling, confirmation step, synonyms, unit words and the FINAL line | nouri-backend turn handler and extraction context; nouri-mobile conversation screen and chips; audio pre-render job |
| `milo/lines.v1.json` | Every keyed Milo and UI line: welcome, setup, plan reveal, building and analysing steps, Today, water, streak, empty states, toasts, safety, permissions, paywall per trigger, scan reactions (rule-based, R-10), Today nudges with conditions, degraded-mode messages, coach quick-action templates (`coach.quickActions`: full, habits-only and degraded variants), the eligibility step and the camera permission explainer | nouri-mobile strings; nouri-backend for nudge and reaction selection and pre-rendered audio; nouri-frontend admin editor |
| `prompts/*.v1.md` | AI prompts: `meal-scan`, `meal-parse`, `onboarding-extract`, `coach`, and the shared `safety-rules` include. Each has front matter (key, model config key, kill switch, limits), a static prefix (persona, rules, output schema) and a dynamic context section after the marker | nouri-backend `modules/ai` prompt registry, seeded into `ai_prompts` (M5-T6) |
| `*.<lang>.json` (for example `questions.v2.bn.json`, `conversation.v1.bn.json`, `lines.v2.bn.json`) | Translations of the files above, one per language, same structure and ids, only the text changed. See Languages below | Same consumers as the English base, served by `?locale=` / `Accept-Language` (ADR 0007) |
| `scripts/validate.mjs` | Dependency-free validator | Run locally and in CI |

## Validate

```bash
node content/scripts/validate.mjs
```

The validator checks the question bank against the schema and then checks cross-references: every branching rule targets a real question and only uses real option IDs, the right operator for the question type, and no forward dependencies; exclusive and grid IDs exist in options; routes, stages and review sections list real questions (stages and review sections cover every question once); the basic route matches the prototype; 17 behaviour fixtures reproduce the prototype's `applicable()` function. It also checks conversation turns, chips and synonyms against the question bank, Milo lines for ID format, at most 3 sentences, banned judgemental words and US spellings, and prompts for a static prefix before the dynamic marker, no placeholders in the prefix, valid JSON blocks and declared includes. Every `<base>.<lang>.json` is also compared with its English base (see Languages). Exit code 1 on any failure.

## Languages

English (`en-GB`) is the source of structure and copy. Another language is one translated file per English file, next to it, so adding a language is data, not code (`../nouri-docs/decisions/0007-multi-language.md`, glossary and tone in `../nouri-docs/product/i18n-bn-style-guide.md`).

- **Naming:** `<base>.<lang>.json` with the same version as its base: `questions.v2.bn.json`, `conversation.v1.bn.json`, `lines.v2.bn.json`. `<lang>` is the registry code (`bn`) and the `locale` field holds the same code. A translation without an English base of the same version fails validation. When you publish `questions.v3.json`, add `questions.v3.<lang>.json` too (a missing file falls back to English for that file only).
- **Parity (enforced by `scripts/validate.mjs`):** identical keys and key order, ids, option ids, day ids, routes, stages, branching, conditions, limits, icons, numbers, booleans and nulls. Only an allow-list of text keys may differ: question `text`, `note`, `miloLine`, `miloLineNoName`, `reviewLabel`, `skipLabel`, `hint`, option `label` / `shortLabel`, day `short` / `label`, stage, route and review-section labels, `review.*` copy; Milo `text` / `title` / `sub`, scan reactions, nudges, paywall copy, degraded messages and the coach block; conversation lines, chip labels, `final`, `fallbackAcks`. Documentation blocks (`tone`, `placeholders`, `source`, `rules`, `notes`, `engine`, `conditionGrammar`, `valueFormats`, `eligibility.*` notes, `rowRule`) stay byte-identical English.
- **Per string:** the same placeholders (`{name}`, `{{x}}`), at most 3 sentences, not empty, written in the language (brand and unit text is only a warning), no judgemental wording, and the same English `hint` is always translated the same way. Milo-line rules (no deadlines, no fasting plans, no calorie figures in habits-only variants, `eligibility.*` rows including `eatingConcern`) apply in every language.
- **Lists in the language:** conversation `synonyms`, `phrases` and `units` are real phrases people type or say (every key needs at least one). `scanReactions.keywords` keeps every English keyword and only adds local ones (stems are fine where the language adds suffixes).
- **Digits:** content files use ASCII digits 0-9 only. The app shows the language's own numerals (for example Bengali ০-৯) and the API always sends ASCII. Bengali digits in a file fail validation.
- **Adding a language:** (1) add the code to `src/shared/locales.ts` and the app registries; (2) copy each English file to `<base>.<lang>.json` and translate the allowed text keys only; set `locale` to the code; (3) add a rule pack for the language to `LANG_PACKS` in `scripts/validate.mjs` (script range, digit range, banned wording, figure patterns, the word for "resting"); without a pack only the structural checks run and the validator warns; (4) run `node content/scripts/validate.mjs`; (5) native-speaker and dietitian review before launch, safety copy (`eligibility.*`, `safety.*`) first.

## Prompt layout

```
---            front matter (key, version, modelConfigKey, killSwitch, limits, includes)
# Static prefix
  persona, [[include safety-rules.v1]], rules, output schema, examples
<!-- DYNAMIC CONTEXT BELOW: not cached -->
# Dynamic context
  {{placeholders}} filled per request
```

The registry replaces `[[include safety-rules.v1]]` with the body of `safety-rules.v1.md` (everything after its front matter) and fills `{{placeholders}}` only below the marker, so the prefix is byte-identical across users and OpenAI prompt caching applies (S-18).

## Placeholders in copy

`{name}`-style placeholders in `lines.v1.json` and `questions.v1.json` are listed in each file's `placeholders` block. Lines with `{name}` always have a `NoName` twin (or `miloLineNoName`). Lines without placeholders are canonical and pre-rendered as audio under `tts/{version}/{lineId}.mp3`.

## Versioning rules

1. **Never change or reuse an ID**: question IDs, field keys, option IDs, line IDs, turn IDs and prompt keys are stored in user data and analytics. Saved answers must always mean the same thing.
2. **Copy-only edits** (labels, Milo lines, notes) may be published from the admin panel as a new content version without changing IDs. Publishing bumps the version and triggers the audio pre-render job.
3. **Anything structural** (adding or removing a question or option, changing a type, limit, branching rule, route or turn group) needs a new file: copy `questions.v1.json` to `questions.v2.json`, bump `version`, keep every old ID that still exists, and record the change in `../nouri-docs/decisions/`. Removed options stay readable for old answers.
4. A conversation or lines file names the question set it targets (`questionSetVersion`). Bump both together when needed.
5. Prompts: never edit an active prompt in place. Add `<key>.v2.md`, test it in the admin playground and the eval suites (§16), then activate it. Old versions stay for rollback.
6. Run the validator before every commit. CI must run it too.
