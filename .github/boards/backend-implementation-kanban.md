# Backend implementation — status Kanban

Plan: [.github/plans/backend-implementation.md](../../.github/plans/backend-implementation.md)

## Status snapshot

The tracker reports **P0–P3 complete**, **P4–P7 in progress at the phase level**, and **P8–P9 not started**. It has **53 checked and 19 unchecked checklist items**. One additional unfinished P4 item—the overdue-payment EventBridge invocation—is described in the tracker but has no unchecked checkbox, bringing the remaining work to **20 items**. Exit criteria are included with their related implementation or verification tasks rather than duplicated.

The tracker’s latest repository validation is dated 2026-10-27: focused payment tests, typecheck, targeted lint, and `git diff --check` passed, but those tests did **not** connect to AWS/DynamoDB. On 2026-10-28, the user reported deploying P4-T3 to dev and subsequently confirmed the verification checks passed. This is user-reported external verification; the assistant did not inspect the AWS account.

## Kanban board

| Ready — can start now (parallelizable) | In progress | Blocked — waiting on dependencies | Needs clarification |
|---|---|---|---|
| **P4-T1 · P4** Wire the overdue-payment processor to its scheduled EventBridge invocation. **Acceptance:** scheduled invocation is connected. The tracker explicitly calls this out as outstanding, but it is missing from the unchecked checklist. |  | **P5-T3 · P5** Add replay/integration coverage and measure dashboard p95. **Blocked by:** P5-T1, P5-T2. | None |
| **P5-T1 · P5** Provision and connect DynamoDB Streams with the specified images, retries, and failure destination. |  |  |  |
| **P5-T2 · P5** Add `/dashboard` and `/reports/summary` endpoints backed by summary items. |  | **P6-T4 · P6** Add and pass the Arabic PDF fixture test, verifying expected shaped glyphs. **Blocked by:** P6-T2, P6-T3. |  |
| **P6-T1 · P6** Implement secure presigned upload/download flows and document API authorization. |  |  |  |
| **P6-T3 · P6** Bundle and verify required fonts for Arabic PDF rendering. **P6-T2 is complete.** **P7-T2 · P7** Benchmark a 10,000-row export and meet the 120-second limit. **P4-T3 deployment is verified.** |  | **P8-T3 · P8** Run the OWASP ZAP baseline and address findings until there are no medium-or-higher findings. **Blocked by:** P8-T1, P8-T2. |  |
| **P7-T1 · P7** Add representative report fixtures and integration coverage for filters, date ranges, and empty results. |  | **P9-T4 · P9** Run the k6 scenario and verify p95 ≤ 400 ms and p99 ≤ 1,000 ms at 100 concurrent users. **Blocked by:** P9-T1, P9-T2. |  |
| **P8-T1 · P8** Implement `/admin/*`, authorization, impersonation, and audit logging. |  | **P9-T5 · P9** Exercise the operational runbook. **Blocked by:** P9-T2, P9-T3. |  |
| **P8-T2 · P8** Implement specified rate limits, security headers, and remaining security controls. |  |  |  |
| **P9-T1 · P9** Create the k6 smoke/load scenario. |  |  |  |
| **P9-T2 · P9** Provision and verify production Terraform, alarms, and deployment/rollback procedures. |  |  |  |
| **P9-T3 · P9** Write the operational runbook. |  |  |  |
| **P7-T1 · P7** Add representative report fixtures and integration coverage for filters, date ranges, and empty results. |  | **P9-T5 · P9** Exercise the operational runbook. **Blocked by:** P9-T2, P9-T3. |  |
| **P8-T1 · P8** Implement `/admin/*`, authorization, impersonation, and audit logging. |  |  |  |
| **P8-T2 · P8** Implement specified rate limits, security headers, and remaining security controls. |  |  |  |
| **P9-T1 · P9** Create the k6 smoke/load scenario. |  |  |  |
| **P9-T2 · P9** Provision and verify production Terraform, alarms, and deployment/rollback procedures. |  |  |  |
| **P9-T3 · P9** Write the operational runbook. |  |  |  |

## Completed this batch

- **P4-T2 · P4** Owner-authenticated quittance route and idempotent PDF job/SQS producer implemented; focused tests, typecheck, and targeted ESLint passed (2026-10-28 batch; validation evidence dated 2026-10-27).
- **P4-T3 · P4** Queue/DLQ, event-source mapping, visibility-timeout, and IAM configuration implemented and validated. User reports dev deployment and successful verification on 2026-10-28; deployed verification is external/user-reported.
- **P4-T4 · P4** User reports successful dev verification of the full SQS → worker → document flow and quittance idempotency on 2026-10-28; external/user-reported verification.
- **P6-T2 · P6** Lease, fiche de police, and état des lieux templates/data validated; privacy regression test added. Focused tests and targeted ESLint passed (2026-10-28 batch).

## Dependency order

1. **Start in parallel:** P4-T1, P5-T1–T2, P6-T1, P6-T3, P7-T1–T2, P8-T1–T2, and P9-T1–T3. P4-T3 and P4-T4 have user-reported dev verification; P6-T2 is complete.
2. **After prerequisites:** P5-T3, P6-T4, P8-T3, P9-T4, and P9-T5, as listed in the blocked lane.
3. **Then:** P6-T4, after the Arabic template and fonts are ready.

## Next actions

Start **P4-T1, P6-T3, and P7-T2**. P7-T2 is now unblocked by the user-verified P4-T3 dev deployment.

## Evidence and assumptions

- The plan records the worker foundations and aggregation processor as implemented, but leaves their integration, infrastructure, API, and exit-criteria work outstanding.
- Repository search found worker processors, but no matching SQS/EventBridge infrastructure in the Terraform files and no dashboard/summary route matches in the searched source. Relevant locations included `infra/terraform/main.tf`, `src/workers/`, and `src/modules/payment/routes.ts`.
- Dependencies between each implementation and its integration/acceptance test are inferred from the deliverables. The plan’s specification defines P1→P4 as the critical path and calls for P6 to start early; it does not require every phase to finish before the next begins. See `.github/backend.md`.
- P6’s tracker says font work is conditional, while the specification makes Arabic rendering a phase exit criterion. The board treats the Arabic template, fonts, and fixture as required work for that exit.