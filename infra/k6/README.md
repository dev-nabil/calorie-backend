# k6 load tests (plan §16, M9-T8)

`nouri.js` runs five scenarios at once, scaled by `PEAK` (requests/second; launch assumption 500, gate at 10×):

| Scenario | Share of PEAK | What it checks |
|---|---|---|
| `today` | 60% | `GET /days/{date}` p95 < 300 ms |
| `meals` | 25% | `POST /meals` + same-key replay (no double writes) + water, p95 < 500 ms |
| `scans` | 5% | presign → upload → `POST /scans` → poll; end-to-end p50 < 6 s, p95 < 15 s |
| `coach` | 5% | coach quick action over SSE |
| `signin` | 1 rps | `POST /auth/email/start` (DEV_OTP only) |

```sh
# local smoke (start:local running; uses the dev OTP route)
k6 run -e BASE=http://localhost:3000 -e DEV_OTP=1 -e PEAK=20 infra/k6/nouri.js
# staging (real Gemini: raise scan.dailyRequestCap / scan.dailySpendUsd first; RATE_LIMIT_MULTIPLIER raised for the run)
k6 run -e BASE=https://api.staging.example -e TOKENS=tokens.json -e PEAK=5000 infra/k6/nouri.js
```

`TOKENS` is a JSON array of access tokens for pre-created test users (one per VU is ideal). Free test users hit the 1-scan and 10-coach limits quickly; give them Plus (`POST /v1/admin/users/{id}/entitlement`) for load runs. Thresholds fail the run when an SLO is missed.
