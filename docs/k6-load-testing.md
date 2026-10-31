# Local k6 smoke/load check

This scenario exercises only the read-only `GET /health` endpoint. Its target guard
accepts HTTP loopback URLs only (`localhost`, `127.0.0.1`, or `::1`); remote hosts,
HTTPS targets, credentials, query strings, and fragments are rejected. Keep this
scenario local: production/deployed load testing requires a separately approved,
controlled test plan and is not enabled by this script.

## Run locally

1. Install k6 using the official installation instructions for your operating system.
2. Start the API locally in a separate terminal (`pnpm dev`) and confirm
   `http://127.0.0.1:3000/health` responds with HTTP 200.
3. Run a short smoke check:

   ```sh
   k6 run load/k6-smoke.js
   ```

4. Run the defined stepped profile, which ramps to and holds 100 virtual users:

   ```sh
   k6 run --env PROFILE=load load/k6-smoke.js
   ```

   To use another local loopback port, pass `--env BASE_URL=http://127.0.0.1:PORT`.
   The script defaults to `http://127.0.0.1:3000` and `PROFILE=smoke`.

Both profiles check the health response, fail on more than 1% failed requests,
require at least 99% successful checks, and apply the phase latency thresholds
(p95 < 400 ms and p99 < 1,000 ms). These thresholds are scenario gates, not evidence
of deployed performance. Run `pnpm exec vitest run test/unit/k6-smoke.test.ts` to
validate JavaScript syntax, profile settings, and the local-target restriction
without starting k6 or contacting a network service.
