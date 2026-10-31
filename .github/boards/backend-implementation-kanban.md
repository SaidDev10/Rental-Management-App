# Backend implementation — status Kanban

Plan: [.github/plans/backend-implementation.md](../../.github/plans/backend-implementation.md)

## Status snapshot

The tracker reports **P0–P3 complete** and **P4–P9 in progress at the phase level**. It has **63 checked and 12 unchecked checklist items**. Exit criteria are included with their related implementation or verification tasks rather than duplicated.

Latest tracker reconciliation (2026-10-31): focused auth/OTP/notification and maintenance-attachment tests passed (8 files, 48 tests), targeted ESLint, `pnpm typecheck`, and `git diff --check` passed. The P8-T2 concurrent password-reset race is addressed with a DynamoDB transaction that updates the password and consumes the OTP atomically. P6-T1 maintenance-attachment confirmation, S3 object validation, and ticket metadata persistence are implemented and locally verified; no live AWS/S3 verification was performed. A previous lockout assertion failure (expected 423, received 401) is fixed: failed-login counts and lockout timestamps are now persisted by both local and DynamoDB repositories. The focused app/auth suites passed (2 files, 47 tests), with typecheck, targeted ESLint, and diff check also passing. The user reports manually deploying all AWS resources created so far; the supplied Terraform state list includes the table, workers, streams, queues, SNS topic, and alarms/aliases. This is user-reported external deployment, not independently verified here; the state list does not show an API Lambda/API Gateway or SNS email subscription. Production alarm delivery remains unverified. On 2026-10-28, the user also reported successful P4-T3 dev verification.

## Kanban board

| Ready — can start now (parallelizable) | In progress | Blocked — waiting on dependencies | Needs clarification |
|---|---|---|---|
|  | **P5-T3 · P5** Add replay/integration coverage and measure dashboard p95. **DynamoDB Local replay passes; mocked in-process p95 is not the required end-to-end/deployed measurement.** |  |  |
|  |  | **P4-T1 · P4** Implement overdue-payment scheduled processing. **Blocked by:** missing API Lambda/deployment, signed internal invocation, and bounded all-account processor. |  |
|  |  | **P8-T3 · P8** Run the OWASP ZAP baseline and address findings until there are no medium-or-higher findings. **Blocked by:** P8-T2. |  |
|  |  | **P9-T4 · P9** Run the k6 scenario and verify p95 ≤ 400 ms and p99 ≤ 1,000 ms at 100 concurrent users. **Blocked by:** API endpoint/deployment path and approved test target; P9-T1 scenario is complete. |  |
|  |  | **P9-T5 · P9** Exercise the operational runbook. **Blocked by:** API deployment, confirmed alarm notification route, and approved exercise window; P9-T3 runbook is written. |  |
|  | **P7-T2 · P7** Benchmark a 10,000-row export against the deployed worker. **Local mocked benchmark passed; deployed test data/job requires approval.** |  |  |
|  | **P8-T2 · P8** Implement specified rate limits, security headers, and remaining security controls. **Persistent 5-minute OTPs, MFA/reset delivery, generic reset responses, and atomic password-reset/OTP consumption are locally verified; API Gateway throttling/deployment and ZAP remain.** |  |  |
|  | **P9-T2 · P9** Provision and verify production Terraform, alarms, and deployment/rollback procedures. **User reports deployed resources shown in supplied state list; API deployment and SNS subscription/delivery verification remain.** |  |  |

## Completed this batch

- **P4-T2 · P4** Owner-authenticated quittance route and idempotent PDF job/SQS producer implemented; focused tests, typecheck, and targeted ESLint passed (2026-10-28 batch; validation evidence dated 2026-10-27).
- **P4-T3 · P4** Queue/DLQ, event-source mapping, visibility-timeout, and IAM configuration implemented and validated. User reports dev deployment and successful verification on 2026-10-28; deployed verification is external/user-reported.
- **P4-T4 · P4** User reports successful dev verification of the full SQS → worker → document flow and quittance idempotency on 2026-10-28; external/user-reported verification.
- **P5-T1 · P5** Connected the active-stage DynamoDB stream to the aggregator Lambda with specified batching, retry, bisection, partial-failure, parallelization, and DLQ settings. Terraform fmt, validate, and mocked tests (2 runs) passed; no apply/deployment.
- **P5-T2 · P5** Added owner-authenticated, account-scoped `/dashboard` and `/reports/summary` endpoints using summary items and indexed reads only. Focused suite (29 tests), typecheck, targeted ESLint, and diff check passed.
- **P7-T1 · P7** Added representative payment/lease fixtures and processor integration tests covering filters, inclusive date ranges, empty exports, account isolation, and Query-only access. Tests (3), ESLint, typecheck, and diff check passed. Fixed the centimes header formatting revealed by workbook assertions.
- **P6-T2 · P6** Lease, fiche de police, and état des lieux templates/data validated; privacy regression test added. Focused tests and targeted ESLint passed (2026-10-28 batch).
- **P6-T3 · P6** Bundled Inter, Noto Sans, and Noto Naskh Arabic fonts with SIL OFL notices; PDF CSS embeds base64 `@font-face`, and `pnpm build:pdf` verifies fonts are copied byte-for-byte. Focused PDF tests (5), targeted ESLint, typecheck, and PDF build passed (2026-10-31). No deployment performed.
- **P6-T4 · P6** Added a real Arabic PDF render/text extraction test that verifies Noto Naskh Arabic loaded and the expected shaped glyph sequence. The focused run passed 6 tests using installed Windows Chrome; typecheck and targeted ESLint passed. CI/Linux bundled-Chromium execution was not run.
- **P6-T1 · P6** Implemented owner-only maintenance attachment upload confirmation, account-scoped ticket/key checks, S3 HeadObject validation of actual content type and size, and ticket metadata persistence. Updated the authorization guide. Verified with 4 focused files / 17 tests, `pnpm typecheck`, targeted ESLint, and `git diff --check`; no live AWS/S3 operation was performed.
- **P8-T1 · P8** Admin routes, authorization, impersonation, and audit logging are implemented. The audit actor now reads API Gateway Lambda request context for source IP/request ID. Admin tests (2 files, 11 tests), targeted ESLint, `pnpm typecheck`, and `git diff --check` passed; no AWS action was performed.
- **P9-T1 · P9** Loopback-only k6 smoke/load scenario and profile assertions are complete. Focused k6 tests (3), ESLint, `k6 inspect` for smoke and load profiles, and diff checks passed. No latency run was made because the local API was unavailable at `127.0.0.1:3000`.
- **P9-T3 · P9** Operational cutover runbook is written, linked, and reconciled with `infra/terraform/alarms.tf`. It documents the defined worker/DLQ/DynamoDB/concurrency alarms and the still-unverified production SNS/API deployment gaps. P9-T5 tracks the operational exercise separately.

## Dependency order

1. **2026-10-31 batch 1:** P4-T1 is blocked because the API Lambda deployment/invocation path, signed internal request validation, and bounded all-account processor are missing. P6-T3 is complete. P7-T2 remains in progress: a local 10,000-row processor benchmark passed, but deployed-worker validation is outstanding and requires approval for a controlled live test. The three cards were originally delegated in parallel. P4-T3 and P4-T4 have user-reported dev verification; P6-T2 is complete.
2. **2026-10-31 batch 2:** P5-T1, P5-T2, and P6-T4 are complete and repository-verified. They were delegated in parallel. P5-T3 became ready after P5-T1/T2 were complete; P6-T4 was unblocked by completed P6-T2/T3.
3. **2026-10-31 batch 3:** P7-T1 is complete. P5-T3 remains in progress: mocked replay passed, DynamoDB Local integration was skipped because Docker was unavailable, and the mocked warm-path benchmark is not end-to-end/deployed latency. P6-T1's maintenance attachment route/service/repository are present; focused tests now pass, but API authorization documentation remains. No AWS/S3 deployment was run for these tasks.
4. **Batch 6 (2026-10-31):** P8-T1 and P9-T1 are complete; P8-T2 remains in progress. P9-T2 has local worker-alarm/alias configuration and passing mocked Terraform tests. The user reports manually deploying resources in the supplied Terraform state list; API deployment and SNS subscription/delivery verification remain outstanding. P9-T3 runbook is written, validated, and reconciled with current Terraform. P8-T2 continuation batch 7 was cancelled before returning any implementation.
5. **Batch 8 (2026-10-31):** P5-T3 DynamoDB Local replay verified (1 integration test); its mocked p95 benchmark is explicitly non-end-to-end (0.585 ms, not deployed latency). P6-T1 authorization docs and focused tests were complete for the documentation scope. P8-T2 persistent OTP challenges, five-minute TTL, MFA/reset notification delivery, generic reset responses, and reset contract changes passed focused validation (4 files / 27 tests); API Gateway throttling/deployment and ZAP remained. No AWS changes or deployment were authorized.
6. **Current blocked work:** P4-T1, P8-T3, P9-T4, and P9-T5, for the dependencies stated in the blocked lane.
7. **Batch 9 (2026-10-31):** P6-T1 maintenance-attachment confirmation, S3 object validation, and ticket metadata persistence were implemented and verified locally (4 files / 17 tests). P8-T2 concurrent password-reset handling now updates the password and consumes the OTP atomically; the combined focused auth/attachment suite passed (8 files / 48 tests), as did `pnpm typecheck`, targeted ESLint, and `git diff --check`. No AWS changes, live S3 verification, or deployment occurred.

## Next actions

1. Continue P5-T3 only when a representative end-to-end/deployed dashboard measurement target is available; the DynamoDB Local replay/idempotency test is verified.
2. Keep P8-T2 open for API Gateway throttling/deployment integration; then run the ZAP baseline (P8-T3).
3. Keep P7-T2 deployed-worker benchmarking, any further P9-T2 changes, P9-T4 load acceptance, and P9-T5 runbook exercise gated on required user approval. P9-T4/T5 additionally need the API deployment and, for runbook exercise, a confirmed alarm notification route.
4. Resolve P4-T1 prerequisites: API Lambda/deployment, signed internal invocation, and bounded all-account overdue processing.

## Evidence and assumptions

- The plan records the worker foundations and aggregation processor as implemented, but leaves their integration, infrastructure, API, and exit-criteria work outstanding.
- P4-T1 inspection found no API-handler Lambda or EventBridge Scheduler resource in `infra/terraform`, no direct signed-invocation path/HMAC validation in the app, and no global bounded all-account overdue processor. These are prerequisites to wire the §14.1 schedule.
- P7-T2’s local processor benchmark excludes real DynamoDB and S3/SQS latency and is not equivalent to deployed-worker measurement.
- Repository search found no dashboard/summary route matches in the searched source. Relevant locations included `infra/terraform/main.tf`, `src/workers/`, and `src/modules/payment/routes.ts`.
- Dependencies between each implementation and its integration/acceptance test are inferred from the deliverables. The plan’s specification defines P1→P4 as the critical path and calls for P6 to start early; it does not require every phase to finish before the next begins. See `.github/backend.md`.
- P6’s tracker says font work is conditional, while the specification makes Arabic rendering a phase exit criterion. The board treats the Arabic template, fonts, and fixture as required work for that exit.