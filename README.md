# nouri-backend

NestJS 11 API and BullMQ worker for Nouri. One codebase, two deployables: `ROLE=api` serves HTTP, `ROLE=worker` runs the queue processors (`src/main.ts` picks the root module). `ROLE=all` (the development default in `.env.example`) does both in one process, so `pnpm start:dev` is enough.

## Structure

Follows the NestJS [modules](https://docs.nestjs.com/modules) guidance: one feature module per folder, one class per file, cross-cutting building blocks in `common/`, configuration in `config/`.

```
nouri-backend/
├── src/
│   ├── main.ts               entry point (ROLE=api | worker | all)
│   ├── app.module.ts         API root module        worker.module.ts   worker root module
│   ├── app.setup.ts          HTTP setup shared by main.ts, e2e tests and the OpenAPI script
│   ├── config/               env schema (zod) and ConfigModule
│   ├── common/               cross-cutting Nest building blocks
│   │   ├── auth/  errors/  http/  idempotency/  integrity/  logging/  metrics/  rate-limit/  zod/
│   ├── modules/              feature modules (see below)
│   │   └── feature-modules.ts   list of modules the API role loads
│   ├── domain/               pure business rules, no Nest/DB imports (lint-enforced), 90% coverage gate
│   ├── infra/                kv/ (Redis or memory), mongo/, storage/ (local or S3), media/, telemetry/
│   ├── jobs/                 BullMQ job queue, scheduled jobs, worker module list
│   ├── shared/               contract shared by every layer: enums, constants, units, time, i18n, dto/ (zod)
│   └── scripts/              CLI entry points run with node (see package.json)
├── test/                     e2e specs (supertest + in-memory Mongo), fixtures, setup
├── content/                  question bank, Milo lines, AI prompts (served by the API)
├── openapi/openapi.json      the API contract, regenerated with `pnpm openapi`
├── evals/                    AI evaluation fixtures
└── infra/                    docker-compose, terraform, k6
```

### Anatomy of a feature module (`src/modules/<feature>/`)

```
<feature>.module.ts            API module                 <feature>-worker.module.ts   worker module (only when it has jobs)
<feature>.controller.ts        or controllers/            <feature>.service.ts         or services/
schemas/<feature>.schema.ts    Mongoose models            providers/                   third-party adapters (email, push, store, ...)
*.handler.ts / *.processor.ts  queue job handlers         *.spec.ts                    unit tests next to the code
```

Sub-folders appear only when a module has several files of that kind. Request/response shapes are zod schemas in `src/shared/dto`, so validation and OpenAPI come from one source.

## Commands

```sh
pnpm install
cp .env.example .env            # then fill in; check with `pnpm env:doctor`
pnpm start:dev                  # API + worker in one process with watch (ROLE=all in .env)
pnpm start:worker               # only for a separate worker (production layout, ROLE=api in .env)
pnpm start:local                # API with embedded Mongo, no Docker needed
pnpm lint | typecheck | test    # test = content validation + unit + e2e
pnpm openapi                    # regenerate openapi/openapi.json (commit it with API changes)
pnpm admin:seed | plan:smoke | coach:smoke | eval:meal-scan
```

`pnpm build` compiles to `dist/`; `node dist/main.js` runs it (the Docker image does exactly this).

## AI

Every AI feature (onboarding extraction, meal-text parsing, coach chat and moderation, plan narrative, conversation summaries, text to speech, food photo scans and the Realtime voice token) runs on Google Gemini through the official `@google/genai` SDK, inside `src/modules/ai` (decision 0011). One key, `GEMINI_API_KEY`; `AI_PROVIDER=fake` (the default in `.env.example`, refused in production) swaps in deterministic fakes. Spend is capped by `AI_MONTHLY_BUDGET_USD` (alert and downgrade thresholds in the admin AI settings); food photo scans keep their own daily caps (`GEMINI_FOOD_DAILY_*`) outside that budget.
