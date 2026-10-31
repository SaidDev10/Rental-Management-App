# Backend implementation — status Kanban

Plan: [.github/plans/backend-implementation.md](../../.github/plans/backend-implementation.md)

## Status snapshot

The tracker reports **P0–P3 complete**, **P4–P7 in progress at the phase level**, and **P8–P9 not started**. It has **59 checked and 14 unchecked checklist items**. Exit criteria are included with their related implementation or verification tasks rather than duplicated.

Latest repository validation (2026-10-31) passed for Terraform stream configuration tests, focused dashboard/API tests, PDF Arabic render/extraction tests, typecheck, targeted ESLint, and diff checks. Terraform tests used a mocked provider; no AWS apply or deployment was performed. Earlier payment tests did not connect to AWS/DynamoDB. On 2026-10-28, the user reported deploying P4-T3 to dev and subsequently confirmed the verification checks passed; this remains user-reported external verification.

## Kanban board

| Ready — can start now (parallelizable) | In progress | Blocked — waiting on dependencies | Needs clarification |
|---|---|---|---|
|  | **P5-T3 · P5** Add replay/integration coverage and measure dashboard p95. **P5-T1 and P5-T2 are complete.** |  |  |
|  | **P6-T1 · P6** Implement secure presigned upload/download flows and document API authorization, including the maintenance-ticket attachment route. | **P8-T3 · P8** Run the OWASP ZAP baseline and address findings until there are no medium-or-higher findings. **Blocked by:** P8-T1, P8-T2. |  |
|  |  | **P9-T4 · P9** Run the k6 scenario and verify p95 ≤ 400 ms and p99 ≤ 1,000 ms at 100 concurrent users. **Blocked by:** P9-T1, P9-T2. |  |
|  |  | **P9-T5 · P9** Exercise the operational runbook. **Blocked by:** P9-T2, P9-T3. |  |
|  | **P8-T1 · P8** Implement `/admin/*`, authorization, impersonation, and audit logging. |  |  |
|  | **P8-T2 · P8** Implement specified rate limits, security headers, and remaining security controls. |  |  |
|  | **P9-T1 · P9** Create the k6 smoke/load scenario. |  |  |
|  | **P9-T2 · P9** Provision and verify production Terraform, alarms, and deployment/rollback procedures. **Local Terraform validation passed; AWS production verification remains blocked pending approval.** |  |  |
|  | **P9-T3 · P9** Write and reconcile the operational runbook. **Runbook written and validated locally; production exercise remains blocked pending approval and the missing API/alarm path.** |  |  |

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

## Dependency order

1. **2026-10-31 batch 1:** P4-T1 is blocked because the API Lambda deployment/invocation path, signed internal request validation, and bounded all-account processor are missing. P6-T3 is complete. P7-T2 remains in progress: a local 10,000-row processor benchmark passed, but deployed-worker validation is outstanding and requires approval for a controlled live test. The three cards were originally delegated in parallel. P4-T3 and P4-T4 have user-reported dev verification; P6-T2 is complete.
2. **2026-10-31 batch 2:** P5-T1, P5-T2, and P6-T4 are complete and repository-verified. They were delegated in parallel. P5-T3 became ready after P5-T1/T2 were complete; P6-T4 was unblocked by completed P6-T2/T3.
3. **2026-10-31 batch 3:** P7-T1 is complete. P5-T3 remains in progress: mocked replay passed, DynamoDB Local integration was skipped because Docker was unavailable, and 500 mocked in-process warm requests measured p95 0.83 ms (not end-to-end/deployed). P6-T1 remains in progress: core document APIs are implemented and tested, but review found the specified maintenance-ticket attachment route missing; no AWS/S3 deployment was run.
4. **Remaining blocked work:** P8-T3, P9-T4, and P9-T5, as listed in the blocked lane.

## Next actions

After the current batch, select from P8-T1, P8-T2, and P9-T1–T3. P4-T1 remains blocked on implementation prerequisites. P5-T3 still needs the local database replay test and a representative end-to-end/deployed dashboard latency measurement. P6-T1 needs the maintenance attachment route and tests. P7-T2 needs user approval before creating live test data/jobs and export artifacts to measure the deployed worker; local baseline alone does not meet acceptance.

## Evidence and assumptions

- The plan records the worker foundations and aggregation processor as implemented, but leaves their integration, infrastructure, API, and exit-criteria work outstanding.
- P4-T1 inspection found no API-handler Lambda or EventBridge Scheduler resource in `infra/terraform`, no direct signed-invocation path/HMAC validation in the app, and no global bounded all-account overdue processor. These are prerequisites to wire the §14.1 schedule.
- P7-T2’s local processor benchmark excludes real DynamoDB and S3/SQS latency and is not equivalent to deployed-worker measurement.
- Repository search found no dashboard/summary route matches in the searched source. Relevant locations included `infra/terraform/main.tf`, `src/workers/`, and `src/modules/payment/routes.ts`.
- Dependencies between each implementation and its integration/acceptance test are inferred from the deliverables. The plan’s specification defines P1→P4 as the critical path and calls for P6 to start early; it does not require every phase to finish before the next begins. See `.github/backend.md`.
- P6’s tracker says font work is conditional, while the specification makes Arabic rendering a phase exit criterion. The board treats the Arabic template, fonts, and fixture as required work for that exit.