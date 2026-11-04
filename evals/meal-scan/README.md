# Meal-scan eval (plan §16, M4-T6)

`pnpm eval:meal-scan` runs every fixture in `fixtures/` through the same validation and totals as production (`normaliseAnalysis`) and reports kcal MAPE, item recall, non-food handling, latency and cost per scan. Reports go to `reports/` (gitignored).

- Default provider: the fake. Each fixture's `fakeOutput` stands in for the model, so the harness and metrics are testable in CI.
- Real provider: `EVAL_ALLOW_REAL=1 OPENAI_API_KEY=… pnpm eval:meal-scan -- --provider openai --model gpt-5-mini --allow-real`. Both the flag and the env var are required. Images come from `images/<id>.jpg` (not committed: they are real labelled photos with weighed reference values). Price per million tokens: `--price-in 0.25 --price-cached 0.025 --price-out 2`.
- Target set: 50+ labelled photos (plan §16). Add one JSON file per photo:

```json
{ "id": "chicken-rice", "category": "lunch",
  "expected": { "isFood": true, "kcal": 470, "items": [{ "name": "chicken", "match": ["chicken"] }] },
  "fakeOutput": { "...": "model output in the meal_analysis schema" } }
```
