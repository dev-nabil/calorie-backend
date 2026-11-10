# nouri-backend

NestJS 11 API for Nouri. One process does everything: it serves HTTP and runs the background work (photo scans, exports, thumbnails, summaries, reminders, nightly jobs) from a MongoDB job queue. There is no Redis and no separate worker; MongoDB is the only service it needs.

## Configuration: environment vs admin settings

- **Environment** (`.env`, validated by `src/config/env.ts`): only secrets, the database URL, storage credentials, the HTTP binding and development switches. See `.env.example`.
- **Admin settings** (admin panel → Settings, `GET/PUT /v1/admin/settings`): everything else, such as the scan model, scan caps and tuning, plan and live-voice models, Google and Apple client IDs, the email sender, device integrity, barcode lookups and the admin panel URL. Registry with types, limits and defaults: `src/modules/settings/settings.registry.ts`; read with `SettingsService.get(key)`. Stored in `app_config`, cached 30 s. Models, limits and the monthly AI budget for the other AI features stay on the admin AI settings page.

## Structure

Follows the NestJS [modules](https://docs.nestjs.com/modules) guidance: one feature module per folder, one class per file, cross-cutting building blocks in `common/`, configuration in `config/`.

```
nouri-backend/
├── src/
│   ├── main.ts               entry point
│   ├── app.module.ts         root module (API + background jobs)
│   ├── app.setup.ts          HTTP setup shared by main.ts, e2e tests and the OpenAPI script
│   ├── config/               env schema (zod) and ConfigModule
│   ├── common/               cross-cutting Nest building blocks
│   │   ├── auth/  errors/  http/  idempotency/  integrity/  logging/  metrics/  rate-limit/  zod/
│   ├── modules/              feature modules (see below)
│   │   └── feature-modules.ts   list of feature modules
│   ├── domain/               pure business rules, no Nest/DB imports (lint-enforced), 90% coverage gate
│   ├── infra/                kv/ (MongoDB key-value store), mongo/, storage/ (local or S3), media/, telemetry/
│   ├── jobs/                 MongoDB job queue and repeating jobs (job_schedules)
│   ├── shared/               contract shared by every layer: enums, constants, units, time, i18n, dto/ (zod)
│   └── scripts/              CLI entry points run with node (see package.json)
├── test/                     e2e specs (supertest + in-memory Mongo), fixtures, setup
├── content/                  question bank, Milo lines, AI prompts (served by the API)
├── openapi/openapi.json      the API contract, regenerated with `pnpm openapi`
├── evals/                    AI evaluation fixtures
├── render.yaml               Render Blueprint (free test server; see DEPLOY-RENDER.md)
└── infra/                    terraform, k6
```

### Anatomy of a feature module (`src/modules/<feature>/`)

```
<feature>.module.ts            the module
<feature>.controller.ts        or controllers/            <feature>.service.ts         or services/
schemas/<feature>.schema.ts    Mongoose models            providers/                   third-party adapters (email, push, store, ...)
*.handler.ts / *.processor.ts  job handlers               *.spec.ts                    unit tests next to the code
```

Sub-folders appear only when a module has several files of that kind. Request/response shapes are zod schemas in `src/shared/dto`, so validation and OpenAPI come from one source.

## Commands

```sh
pnpm install
cp .env.example .env            # then fill in; check with `pnpm env:doctor`
pnpm start:dev                  # the whole backend with watch
pnpm start:local                # API with embedded Mongo, no Docker needed
pnpm lint | typecheck | test    # test = content validation + unit + e2e
pnpm openapi                    # regenerate openapi/openapi.json (commit it with API changes)
pnpm admin:seed | plan:smoke | coach:smoke | eval:meal-scan
```

`pnpm build` compiles to `dist/`; `node dist/main.js` runs it. There is no Docker image: the backend deploys to Render as a native Node service (`render.yaml`, step by step in [DEPLOY-RENDER.md](DEPLOY-RENDER.md)).

## AI

Every AI feature (onboarding extraction, meal-text parsing, coach chat and moderation, plan narrative, conversation summaries, text to speech, food photo scans and the Realtime voice token) runs on Google Gemini through the official `@google/genai` SDK, inside `src/modules/ai` (decision 0011). One key, `GEMINI_API_KEY` (required in production); tests and `pnpm start:local` use deterministic fakes. Spend is capped by the monthly AI budget in the admin AI settings ($10 by default); food photo scans keep their own daily caps (admin settings `scan.dailyRequestCap` and `scan.dailySpendUsd`) outside that budget.
