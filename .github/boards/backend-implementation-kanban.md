# Backend implementation — status Kanban

Plan: [.github/plans/backend-implementation.md](../../.github/plans/backend-implementation.md)

## Status snapshot

The tracker reports **P0–P3 complete**, **P4–P7 in progress at the phase level**, and **P8–P9 not started**. It has **48 checked and 24 unchecked checklist items**. One additional unfinished P4 item—the overdue-payment EventBridge invocation—is described in the tracker but has no unchecked checkbox, bringing the remaining work to **25 items**. Exit criteria are included with their related implementation or verification tasks rather than duplicated.

The tracker’s latest validation is dated 2026-10-27: focused payment tests, typecheck, targeted lint, and `git diff --check` passed, but those tests did **not** connect to AWS/DynamoDB. No tests were rerun and no resources were deployed for this assessment.

## Kanban board

| Ready — can start now (parallelizable) | In progress | Blocked — waiting on dependencies | Needs clarification |
|---|---|---|---|
| **P4-T1 · P4** Wire the overdue-payment processor to its scheduled EventBridge invocation. **Acceptance:** scheduled invocation is connected. The tracker explicitly calls this out as outstanding, but it is missing from the unchecked checklist. | **P4-T2 · P4** Implement domain/API job producers, including the payment quittance endpoint, authorization, and idempotency tests. **Acceptance:** authorized `POST /payments/:id/quittance` enqueues correctly. **Batch 2026-10-27 delegated.** | **P4-T4 · P4** Verify the complete SQS → worker → document flow, including quittance production and idempotency. **Blocked by:** P4-T2, P4-T3. | None |
| **P4-T3 · P4** Provision/configure queues, DLQs, event-source mappings, templates, and IAM permissions. **Batch 2026-10-27 delegated.** |  | **P5-T3 · P5** Add replay/integration coverage and measure dashboard p95. **Blocked by:** P5-T1, P5-T2. |  |
| **P5-T1 · P5** Provision and connect DynamoDB Streams with the specified images, retries, and failure destination. |  | **P6-T3 · P6** Bundle and verify required fonts for Arabic PDF rendering. **Blocked by:** P6-T2 (Arabic template scope/content). |  |
| **P5-T2 · P5** Add `/dashboard` and `/reports/summary` endpoints backed by summary items. |  | **P6-T4 · P6** Add and pass the Arabic PDF fixture test, verifying expected shaped glyphs. **Blocked by:** P6-T2, P6-T3. |  |
| **P6-T1 · P6** Implement secure presigned upload/download flows and document API authorization. |  | **P7-T2 · P7** Benchmark a 10,000-row export and meet the 120-second limit. **Blocked by:** P4-T3 for deployed worker configuration. |  |
| **P6-T2 · P6** Complete and validate lease, fiche de police, and état des lieux templates and document data. **Batch 2026-10-27 delegated.** |  | **P8-T3 · P8** Run the OWASP ZAP baseline and address findings until there are no medium-or-higher findings. **Blocked by:** P8-T1, P8-T2. |  |
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

## Dependency order

1. **Start in parallel:** P4-T1–T3, P5-T1–T2, P6-T1–T2, P7-T1, P8-T1–T2, and P9-T1–T3. The specification identifies P4 as the critical path and says P6’s Arabic PDF work should start early; don’t wait for all intervening phases before beginning P6.
2. **After prerequisites:** P4-T4, P5-T3, P6-T3, P7-T2, P8-T3, P9-T4, and P9-T5, as listed in the blocked lane.
3. **Then:** P6-T4, after the Arabic template and fonts are ready.

## Next actions

Start **P4-T2 and P4-T3 in parallel**, and begin **P6-T2** alongside them. That advances the P4 critical path while starting the higher-uncertainty Arabic PDF work early. P4-T1 is also independently ready.

## Evidence and assumptions

- The plan records the worker foundations and aggregation processor as implemented, but leaves their integration, infrastructure, API, and exit-criteria work outstanding.
- Repository search found worker processors, but no matching SQS/EventBridge infrastructure in the Terraform files and no dashboard/summary route matches in the searched source. Relevant locations included `infra/terraform/main.tf`, `src/workers/`, and `src/modules/payment/routes.ts`.
- Dependencies between each implementation and its integration/acceptance test are inferred from the deliverables. The plan’s specification defines P1→P4 as the critical path and calls for P6 to start early; it does not require every phase to finish before the next begins. See `.claude/backend.md`.
- P6’s tracker says font work is conditional, while the specification makes Arabic rendering a phase exit criterion. The board treats the Arabic template, fonts, and fixture as required work for that exit.