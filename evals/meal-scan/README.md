# Meal-scan eval (plan §16, M4-T6)

`pnpm eval:meal-scan` runs every fixture in `fixtures/` through the same validation and totals as production (`normaliseAnalysis`) and reports kcal MAPE, item recall, non-food handling, latency and cost per scan. Reports go to `reports/` (gitignored).

- Default provider: the fake. Each fixture's `fakeOutput` stands in for the model, so the harness and metrics are testable in CI.
- Real provider: `EVAL_ALLOW_REAL=1 GEMINI_API_KEY=… pnpm eval:meal-scan -- --provider gemini --model gemini-3.5-flash-lite --allow-real`. Both the flag and the env var are required. Images come from `images/<id>.jpg` (not committed: they are real labelled photos with weighed reference values). `--resolution low|medium|high` compares image token levels. Cost uses the prices in `src/modules/ai/gemini-pricing.ts`.
- Before relying on a model for Bangladeshi meals, add labelled photos of rice, dal, fish curry, chicken, vegetables, roti and biryani: Google publishes no food-recognition benchmark for Flash-Lite.
- Target set: 50+ labelled photos (plan §16). Add one JSON file per photo:

```json
{ "id": "chicken-rice", "category": "lunch",
  "expected": { "isFood": true, "kcal": 470, "items": [{ "name": "chicken", "match": ["chicken"] }] },
  "fakeOutput": { "...": "model output in the schema of content/prompts/meal-scan.v3.md" } }
```
