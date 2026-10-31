# Backend Implementation Status

This tracker follows the phase sequence and exit criteria in [Backend Specification §20](../.github/backend.md#20-implementation-phases). Work has also been done ahead of the sequence on async workers, aggregation, PDF generation, and reports; those early components do not mean their phases are complete.

**Overall status: P0–P3 complete; P4–P9 in progress.** P0 through P3 exit criteria are repository-verified. P4's end-to-end flow and stated exit criterion are user-reported as verified in dev; the separately tracked overdue-payment EventBridge invocation remains outstanding. The API Lambda and API Gateway infrastructure is now implemented and deployed to dev per user report; P9-T6 tracks the Terraform implementation and P9-T7 tracks deployment and live verification. The API health endpoint passes, while protected-route and operational checks remain. Items are checked only when the corresponding deliverable is implemented and verified; user-reported external verification is identified as such.

## P0 — Foundations

**Specification deliverable:** repository scaffold, config, logger, error taxonomy, base repository, ESLint, TypeScript configuration, local development stack, and CI pipeline.

**Status: Complete**

- [x] Create the pnpm project scaffold, TypeScript configuration, ESLint configuration, and unit-test runner.
- [x] Add the Hono app, `/health` route, API Lambda adapter, shared logger, and shared error types.
- [x] Add initial DynamoDB client, key builders, and account-scoped repository primitives.
- [x] Add a Docker Compose development stack for DynamoDB Local and LocalStack, example local AWS endpoint settings, and infra up/down scripts.
- [x] Complete and validate application configuration for the API, authorizer, and all worker roles; parse the API CORS allowlist from configuration.
- [x] Start DynamoDB Local and LocalStack and verify `pnpm dev` with the local AWS endpoint configuration.
- [x] Add CircleCI that installs from the frozen pnpm lockfile and runs typecheck, lint, unit tests, and Lambda builds.
- [x] Meet the phase exit criteria: `pnpm dev` serves `/health`; lint passes; CI passes.

### Verification snapshot
- Started the dev server with the example local configuration and verified `GET /health` returned HTTP 200 with `{"ok":true,"service":"rental-api",...}`.
- CI-equivalent checks passed: `pnpm typecheck`, `pnpm lint`, `pnpm test` (12 files, 59 tests), and `pnpm build` (all six Lambda bundles passed size checks).

## P1 — Data layer

**Specification deliverable:** all item types, key builders, repositories, DynamoDB Local integration tests.

**Status: Complete — user confirmed dev table, GSIs, PITR, TTL, and stream settings are provisioned**

- [x] Add account-scoped key builders and shared repository operations with account/GSI key checks.
- [x] Add account-scoped job repository operations and conditional job transitions.
- [x] Define and implement the property domain item/repository contract used by the API.
- [x] Remove the duplicate root-level property routes now that the property module owns the `/properties` route mount.
- [x] Provision the table and both GSIs through Terraform.
- [x] Run DynamoDB Local integration tests covering every §7.4 access pattern.
- [x] Meet the phase exit criteria: table and GSIs are provisioned; every specified access pattern is proven by a test.

Progress: Terraform configuration uses the stage-specific naming contract in §7.1 (`rental-app-${stage}-db`). The user confirms they applied Terraform and verified the dev table, both GSIs, PITR, TTL, and stream settings. The local-only integration suite passes against DynamoDB Local and exercises all 17 §7.4 patterns, including GSI queries followed by `BatchGetItem`. The dev and prod backends use separate state keys and native S3 lockfiles.

## P2 — Auth

**Specification deliverable:** registration, login, MFA, refresh/logout, JWT, session model, and lockout.

**Status: Complete — local auth tests and user-reported live dev AWS integration passed**

- [x] Add an API Gateway JWT authorizer entry point that validates RS256 claims and reads the public key from SSM.
- [x] Add Argon2 password hash/verification helpers and RS256 access-token signing/verification scaffolding.
- [x] Replace the service-level demo `Map` with a repository abstraction so auth reads/writes are centralized in a single storage boundary.
- [x] Require verified bearer tokens on the property API and derive the account context from the JWT rather than accepting caller-supplied `x-account-id` values.
- [x] Replace the runtime-generated key pair with a config/SSM-backed key selection path so signing and verification can use configured RSA keys instead of a fresh in-memory key every boot.
- [x] Implement the production-style registration and credential lookup model as a clear account/user/email-directory boundary using the DynamoDB transaction pattern when `TABLE_NAME` is configured, with a safe local fallback for dev/test bootstraps.
- [x] Add a Dynamo-backed session lifecycle path for configured auth tables, including create, lookup, rotation, and revoke operations with local fallback for dev/test bootstrap.
- [x] Prevent production use of the in-memory demo auth store and runtime-generated signing keys; production requires DynamoDB and loads signing keys from SSM, with fail-closed behavior.
- [x] Implement MFA challenge and verification flow, including challenge issuance, verification, and resend path support in the service and routes.
- [x] Implement access/refresh token issuance, rotation, logout, session revocation, and reuse detection.
- [x] Implement login lockout and failed-attempt tracking.
- [x] Implement single-session enforcement for super-admin sessions with authoritative session lookup in the configured auth repository.
- [x] Ensure the auth service and middleware resolve the repository lazily per request so session checks follow the active runtime configuration rather than a stale module-level singleton.
- [x] Harden the in-memory session model to track session lifecycle metadata (`issuedAt`, `expiresAt`, `revokedAt`) and consumed refresh-token state per family.
- [x] Integrate verified claims and authoritative session checks into API request context; remove caller-supplied account identity.
- [x] Meet the phase exit criteria: token-reuse detection passes and super-admin single-session enforcement is tested.

### Verification snapshot
- Focused auth tests pass: `pnpm vitest run test/unit/auth-repository.test.ts test/unit/auth-token-keys.test.ts test/unit/app.test.ts` (21 tests).
- Lockout follow-up: failed-login attempts and the 15-minute lockout timestamp are now persisted by both local and DynamoDB auth repositories; successful login resets them. `pnpm exec vitest run test/unit/app.test.ts test/unit/auth-repository.test.ts --reporter=dot` passed (2 files, 47 tests); `pnpm typecheck`, targeted ESLint, and `git diff --check` passed.
- Production repository selection is tested to fail when `TABLE_NAME` is missing, even if `USE_DYNAMO_AUTH=false`; a missing DynamoDB table error is propagated rather than falling back to local state.
- JWT token signing rejects absent configured keys; test-only keys are generated in `test/setup.ts`. Production uses SSM even if PEM env keys are present.
- Replaying a consumed refresh token now atomically revokes its still-active family and writes a `SecurityEvent`; unknown tokens return `INVALID_REFRESH` without revoking the current session. Consumed-token markers use the session's absolute-expiry TTL.
- Added `pnpm run test:auth-live`, an explicit dev-only integration runner for registration, login, invalid-token handling, rotation, replay revocation, logout, and cleanup. It requires explicit live-run/write opt-in and rejects LocalStack test credentials.
- TypeScript check passes: `pnpm typecheck`.
- Targeted ESLint passes for the changed auth and test files.

## P3 — Core CRUD

**Specification deliverable:** property, tenant, lease, and payment modules plus payment schedule generation.

**Status: Complete — property, tenant, lease, and payment flows implemented and verified**

- [x] Implement property CRUD, validation, ownership, and soft-delete constraints.
- [x] Complete the remaining §8.2 property contract: `activeLeaseId` on detail responses and photo presign/record endpoints.
- [x] Implement tenant CRUD and tenant-lease relationships.
- [x] Implement lease lifecycle, validation, and property/tenant constraints.
- [x] Implement payment schedule generation and core payment status transitions.
- [x] Add account-isolation and domain tests for every endpoint.
- [x] Meet the phase exit criteria: authenticated end-to-end flow from registration through property, tenant, lease, and generated payment schedule.

### Verification snapshot
- Implemented authenticated property list/get/create/update/delete APIs with schema validation, account-scoped repository access, idempotent creation, optimistic version checks, soft deletion, and active-lease deletion protection.
- Added status/label filtering, bounded cursor pagination, and support for both `/properties` and `/properties/`.
- Property detail now includes `activeLeaseId`; photo uploads use account/property-scoped, 5-minute presigned PUTs with pinned content type, S3 HEAD verification, 10 MB and 20-photo limits, and conditional versioned recording. Caller-supplied photo keys are rejected by property CRUD.
- Focused validation passed: `pnpm typecheck`, the five focused Vitest files (29 tests), targeted ESLint, and `git diff --check`.
- Repository unit tests cover the property GSI lease lookup and conditional photo update. The live DynamoDB/S3 paths have not been exercised against AWS in this step.
- Tenant list/create/detail/update/delete routes now enforce owner role and use verified account context, sorted GSI1 directory pagination, idempotent creation, optimistic versions, soft deletion, and active tenant-lease link lookups with batch-get retries. Identity document numbers are AES-256-GCM encrypted using the SSM `field-encryption-key`; list/detail responses expose only type and last four, and only the owner-only document route decrypts them.
- Tenant API/auth integration, route, repository, service, and field-crypto tests passed: `pnpm vitest run --silent=true test/unit/app.test.ts test/unit/field-crypto.test.ts test/unit/tenant-repository.test.ts test/unit/tenant-routes.test.ts test/unit/tenant-service.test.ts` (32 tests). `pnpm typecheck`, targeted ESLint, and `git diff --check` passed. No live AWS/DynamoDB run was performed.
- Added authenticated lease list/create/detail/update/terminate/renew/schedule routes, account-scoped persistence and tenant links, optimistic version checks, idempotent creation/renewal, property/tenant ownership and active-property validation, and generated monthly/quarterly payment schedules.
- Lease updates synchronize pending schedule entries without overwriting completed payments; termination cancels future due entries, and renewal atomically expires the predecessor and creates a successor. Local development mode now mirrors tenant/property lease links for detail responses and active-lease deletion guards.
- Lease service validation covers date range, one-year maximum term, unique tenants, amounts, payment terms, and indexation. A regression test verifies that changing terms after lease start updates pending schedule amounts.
- Focused validation passed: `pnpm typecheck`; `pnpm vitest run --silent=true test/unit/app.test.ts test/unit/lease-service.test.ts test/unit/lease-routes.test.ts test/unit/lease-repository.test.ts test/unit/property-service.test.ts test/unit/property-repository.test.ts` (36 tests); targeted ESLint; and `git diff --check` plus `git diff --cached --check`. No live AWS/DynamoDB run was performed.
- Added owner-authenticated `/payments` list, overdue, manual-create, detail, update, mark-paid, and cancel routes. Manual creation verifies the lease/account context and is idempotent; optimistic versions protect edits and status changes.
- Payment transitions now enforce monotonic partial/full amounts, reject overpayment, update GSI2 status keys, guard paid-payment cancellation, and provide conditional processing of past-due due/partial entries as late. The local payment store is shared with lease schedule generation so local API reads and updates act on generated payments.
- Added repository, service, route, account-isolation, and authenticated property→tenant→lease→payment flow coverage. The payment quittance endpoint remains with the P4 job-producer item; the scheduled EventBridge invocation of the overdue processor is not wired yet.
- Focused validation passed: `pnpm typecheck`; `pnpm vitest run --silent=true test/unit/app.test.ts test/unit/lease-service.test.ts test/unit/payment-service.test.ts test/unit/payment-routes.test.ts test/unit/payment-repository.test.ts test/integration/dynamodb-access-patterns.test.ts` (35 tests passed, 2 DynamoDB Local tests skipped because no local endpoint was configured); targeted ESLint; and staged/unstaged `git diff --check`. No live AWS/DynamoDB run was performed.
- Extended payment route tests to cover list, overdue, create, detail, update, mark-paid, and cancel, including request validation and verified account-context propagation. Extended the authenticated end-to-end flow to register and log in a fresh account, create the property/tenant/lease, generate the schedule, and verify a separately registered account cannot list, read, update, pay, cancel, or manually create against those payments.
- Focused validation passed on 2026-10-27: `pnpm vitest run --silent=true test/unit/app.test.ts test/unit/payment-routes.test.ts test/unit/payment-service.test.ts test/unit/payment-repository.test.ts` (30 tests); `pnpm typecheck`; targeted ESLint; and `git diff --check`. These tests use local in-memory auth/domain stores; no live AWS/DynamoDB validation was performed.

## P4 — Async

**Specification deliverable:** job entity, SQS producers, quittance PDF worker, and SES notification worker.

**Status: In progress — SQS-to-document flow and quittance exit criteria verified in dev; overdue-payment scheduling remains outstanding**

- [x] Add account-scoped job state transitions, conditional claims, retry handling, and terminal failure handling.
- [x] Add validated SQS payloads, partial-batch processing, and concrete PDF/report/notification worker processors.
- [x] Add PDF output persistence and atomic job/document completion.
- [x] Add SES/WhatsApp adapters and reminder/overdue deduplication.
- [x] Implement domain/API job producers, including the payment quittance endpoint and its authorization checks.
- [x] Provision and configure the queues, DLQs, event-source mappings, templates, and IAM permissions.
- [x] Exercise the complete SQS-to-worker-to-document flow against AWS-compatible integration services. (User-reported dev verification, 2026-10-28.)
- [x] Meet the phase exit criteria: `POST /payments/:id/quittance` produces a quittance and passes idempotency tests. (User-reported dev verification, 2026-10-28.)
- [ ] Wire the overdue-payment processor to its scheduled EventBridge invocation.

### Verification snapshot
- Provisioned stage-named PDF, report, and notification queues with managed SSE, four-day retention, receive-count-3 DLQs, restrictive redrive allow policies, and worker event-source mappings configured for partial batch failures.
- Added worker Lambda configuration, S3 artifact upload support, log groups, queue/table/document-store/SSM/SES IAM policies, and queue/document/parameter outputs. `terraform fmt -check infra/terraform`, `terraform -chdir=infra/terraform validate`, and `git diff --check -- infra/terraform` passed. At that validation stage, no Terraform plan/apply or AWS integration had been run; the later user-reported dev verification is recorded below.

## P5 — Aggregation

**Specification deliverable:** stream aggregator, summary items, dashboard and summary-report APIs.

**Status: In progress — stream processor and summary APIs implemented; replay/performance remain**

- [x] Add transactional event deduplication and account-scoped summary deltas.
- [x] Handle payment period changes by reversing the old month and applying the new month in one transaction.
- [x] Add unit tests for duplicate events, period changes, account-scoped summary keys, and unsupported entities.
- [x] Provision and connect DynamoDB Streams with the specified images, retries, and failure destination.
- [x] Add `/dashboard` and `/reports/summary` endpoints using the summary items.
- [ ] Add replay/integration coverage and measure dashboard p95.
- [ ] Meet the phase exit criteria: replay idempotency passes and dashboard p95 is measured.

### Verification snapshot
- Provisioned the active-stage table stream consumer with `NEW_AND_OLD_IMAGES`, an encrypted stream DLQ, a least-privilege Lambda role, and an event-source mapping configured for batch size 100, bisection, three retries, partial batch failures, and parallelization factor 1. `terraform fmt -check infra/terraform`, `terraform -chdir=infra/terraform validate`, and mocked `terraform -chdir=infra/terraform test` passed (2 runs). No Terraform apply, AWS mutation, or deployment was performed.
- Added owner-authenticated `/dashboard` and `/reports/summary` routes backed by account-scoped `SUMMARY#` GetItem access. Validation passed: `pnpm exec vitest run test/unit/dashboard-repository.test.ts test/unit/dashboard-service.test.ts test/unit/dashboard-routes.test.ts test/unit/app.test.ts --reporter=dot` (4 files, 29 tests), targeted ESLint, `pnpm typecheck`, source-only TypeScript check, and scoped `git diff --check`. No AWS resources were changed.
- Added stateful mocked replay coverage and DynamoDB Local integration that replays a stream record through the processor, checks the single summary delta and processed marker, then reads the summary through the dashboard repository. In batch 8, Docker was available, only the existing `dynamodb-local` compose service was started, and `DYNAMODB_ENDPOINT=http://127.0.0.1:8000 pnpm exec vitest run test/integration/stream-aggregator-dashboard.test.ts --reporter=dot` passed (1 test); the service was stopped afterward and the port released. The separate warm route benchmark passed (50 warm-ups, 500 sequential requests) and reported p95 `0.585 ms`, but its SDK calls are mocked, it is in-process, and the test marks `qualifiesAsEndToEnd:false`; this is not deployed latency and does not complete the phase performance criterion. No AWS endpoint was contacted.

## P6 — Documents & PDF breadth

**Specification deliverable:** S3 presigned flows, lease/police/condition-report templates, and Arabic rendering validation.

**Status: In progress — document presigned flows and authorization implemented and locally verified; deployed validation remains**

- [x] Add Chromium-backed PDF generation for quittance and lease-related job types, with S3 output.
- [x] Implement secure presigned upload/download flows and document API authorization, including `POST /maintenance/tickets/:id/attachments`.
- [x] Complete and validate the lease, fiche de police, and état des lieux templates and document data.
- [x] Bundle and verify the required fonts for Arabic PDF rendering.
- [x] Add the Arabic PDF fixture test before shipping any Arabic template.
- [x] Meet the Arabic rendering criterion: the fixture renders and extracted text contains the expected shaped glyphs.

### Verification snapshot
- Added a Chromium-backed Arabic fixture test that renders the base64-embedded Noto Naskh Arabic font to a real PDF and extracts its text with PDF.js. The test verifies the font face loaded and asserts the extracted presentation-form glyph sequence for `السلام عليكم`. Validation passed: `$env:PUPPETEER_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'; pnpm exec vitest run test/unit/pdf-arabic-render.test.ts test/unit/pdf-documents.test.ts` (6 tests), `pnpm typecheck`, targeted ESLint, and `git diff --check`. Windows Chrome was used; execution under Linux CI with bundled Chromium has not been run.
- Bundled Inter, Noto Sans, and Noto Naskh Arabic variable fonts with their SIL OFL 1.1 notices in the PDF worker artifact. Template CSS embeds each font as a base64 `@font-face`; `pnpm exec vitest run test/unit/pdf-documents.test.ts`, targeted ESLint, `pnpm typecheck`, and `pnpm build:pdf` passed, and the ZIP contains all three fonts and notices. No AWS resources were changed.
- Added differentiated lease-agreement, fiche de police, and entry/exit état des lieux contexts using account-scoped lease, property, and tenant data. The lease includes dates, rent, charges, deposit, payment terms, and indexation; the police sheet uses available tenant particulars and only the stored ID last-four value; the condition report includes a printable checklist and signature lines.
- Added local payload/HTML fixtures covering the three lease-related types plus the existing quittance path, including output escaping. Validation passed: `pnpm vitest run test/unit/pdf-documents.test.ts test/unit/document-processors.test.ts` (6 tests), `pnpm typecheck`, targeted ESLint, `pnpm build:pdf`, and `git diff --check`. No AWS services or resources were used.
- Added owner-authenticated, account-scoped document list/metadata/download-url/presign/upload-confirm/soft-delete routes, DynamoDB metadata persistence and linked-entity ownership checks, and S3 upload verification (account key, exact Content-Type and declared size, 10 MB limit). Download URLs use a 300-second GetObject signature and a sanitized attachment filename. The specified `POST /maintenance/tickets/:id/attachments` route, ticket-scoped repository check, and service are present. `pnpm exec vitest run test/unit/maintenance-attachment-repository.test.ts test/unit/maintenance-attachment-service.test.ts test/unit/maintenance-attachment-routes.test.ts --reporter=dot --silent` passed (3 files, 6 tests). API authorization documentation remains missing; no AWS resources were changed or deployed.
- Added `docs/document-api-authorization.md` with owner/bearer authorization, claim-derived account scope, account-scoped linked-entity checks, document metadata/presign/confirm/download contracts, MIME/size limits, and 300-second presigned URL handling. Review against the route/service/storage code and spec §8.6–8.7 identified an acceptance gap: maintenance-ticket attachment upload currently only presigns, with no confirm route, actual-object validation, or metadata persistence, despite §8.7 requiring the §8.2 rules. No runtime change was made. Validation passed: `pnpm exec vitest run test/unit/document-routes.test.ts test/unit/document-service.test.ts test/unit/document-repository.test.ts test/unit/document-storage.test.ts test/unit/maintenance-attachment-repository.test.ts test/unit/maintenance-attachment-service.test.ts test/unit/maintenance-attachment-routes.test.ts --reporter=dot` (7 files, 17 tests), and `git diff --check`.
- P6-T1 maintenance-attachment continuation: added owner-only `POST /maintenance/tickets/:id/attachments/confirm`, validated the caller-account document key and active account-scoped ticket, reused S3 `HeadObject` verification for exact content type/actual size/10 MiB enforcement, and appended `{s3Key, mimeType, sizeBytes}` to the ticket. Updated the authorization guide with the confirmation contract. Validation passed: `pnpm exec vitest run test/unit/maintenance-attachment-routes.test.ts test/unit/maintenance-attachment-service.test.ts test/unit/maintenance-attachment-repository.test.ts test/unit/document-storage.test.ts --reporter=dot` (4 files, 17 tests), `pnpm typecheck`, targeted ESLint, and `git diff --check`. No AWS services, resources, or deployment were used.

## P7 — Reports

**Specification deliverable:** report worker with XLSX/PDF export.

**Status: In progress — processor implemented; specification-scale verification remains**

- [x] Add monthly summary and payment/lease register report processing.
- [x] Add XLSX streaming upload and PDF export paths, report range/row guards, and document/job metadata.
- [x] Add representative report fixtures and integration coverage for filters, date ranges, and empty results.
- [ ] Benchmark a 10,000-row export against the deployed worker configuration.
- [ ] Meet the phase exit criteria: a 10,000-row export completes within 120 seconds.

## P8 — Admin & hardening

**Specification deliverable:** admin routes, impersonation, audit log, rate limits, security headers, and ZAP scan.

**Status: In progress - P8-T1 complete locally; P8-T2 remains incomplete and blocks the ZAP exit criterion.**

- [x] Implement `/admin/*`, authorization, impersonation, and audit logging.
- [ ] Implement specified rate limits, security headers, and remaining security controls.

P8-T2 progress (2026-10-31): login, registration, refresh, MFA, and password-reset routes have per-IP fixed-window limits; service-level counters cover the specified 10/hour MFA-per-user and 3/hour password-forgot-per-email limits. Atomic DynamoDB rate-limit counters, a local test/dev fallback, security headers, CORS preflight max-age, and origin validation for cookie-authenticated refresh requests are implemented. MFA and password-reset challenges persist under `OTP#<userId>` with purpose sort keys (`LOGIN_MFA` / `PASSWORD_RESET`), five-minute TTLs, and conditional per-challenge attempt limits. MFA and reset codes use the notification-job path; password-forgot returns `{sent:true}` for existing and unknown accounts, and reset accepts `{email, code, newPassword}` with a 204 response. Focused validation passed (4 files / 27 tests, targeted ESLint, `pnpm typecheck`, and `git diff --check`). Remaining: API Gateway 50 req/s steady / 100 req/s burst throttling and API deployment/IAM are absent from Terraform and are tracked in P9-T6; no ZAP baseline has run.
- [ ] Run OWASP ZAP baseline against the local/deployed API and address findings.
- [ ] Meet the phase exit criteria: ZAP baseline has no medium-or-higher findings.

### Verification snapshot
- P8-T1 local implementation verified: `pnpm exec vitest run test/unit/admin-security.test.ts test/unit/admin-repository.test.ts --reporter=dot` passed (2 files, 11 tests); targeted ESLint, `pnpm typecheck`, and `git diff --check` passed. The audit actor regression covers API Gateway Lambda request context. No AWS action or deployment was performed.
P8-T2 continuation (2026-10-31): the follow-up corrected observable persistence/enqueue failures, added MFA and resend notification jobs, and aligned the reset request/response contract, spec purpose keys, and five-minute OTP TTL. A same-table DynamoDB transaction now updates the password and conditionally consumes the OTP atomically; local/test store behavior protects against concurrent use and retains the challenge if password persistence fails. Unknown accounts and missing challenges return the same `401 INVALID_OTP`. Focused auth verification passed as part of the combined suite (4 auth files among 8 total; 48 total tests), targeted ESLint, `pnpm typecheck`, and `git diff --check`. No API Gateway Terraform integration was found, so no throttling/deployment resources were added. No AWS calls, apply, deployment, or ZAP scan were performed.

## P9 — Load & cutover

**Specification deliverable:** k6 smoke/load acceptance, production Terraform and alarms, API Lambda/API Gateway deployment, and runbook.

**Status: In progress - local k6 scenario complete; measured load and production verification remain**

- [x] Add the loopback-only k6 smoke/load scenario, including the 100-VU profile and local validation tests.
- [ ] Run the k6 scenario at target concurrency and record measured results.
- [ ] Provision and verify non-API production Terraform, alarms, SNS notification routing, and deployment/rollback procedures.
- [x] **P9-T6:** Implement and locally validate Terraform deployment resources for `api-handler`, the Lambda authorizer, and API Gateway HTTP API, including artifact publishing/aliases, least-privilege IAM/environment configuration, route/invoke wiring, CORS, 50 req/s steady and 100 req/s burst throttling, API-specific alarms/outputs, and focused tests.
- [ ] **P9-T7:** Deploy and verify the API Lambda/API Gateway in the approved target stage(s), starting with dev. Requires P9-T6 completion and explicit approval before each AWS mutation; verify health, authorization/routing, throttling configuration, logs/alarms, and documented API URL. Production deployment requires separate explicit approval.
- [x] Write the operational deployment, smoke-check, alarm-response, rollback, and team-handoff runbook.
- [ ] Exercise the operational runbook after production deployment, alarms, and approval are available.
- [ ] Meet the phase exit criteria: p95 is at most 400 ms and p99 is at most 1,000 ms at 100 concurrent users.

P9-T2 progress (2026-10-31): local Terraform validation passes for the alarm and alias setup: `terraform fmt -recursive`, `terraform init -backend=false`, `terraform validate`, and `terraform test` all passed (4/4). The module includes DLQ, worker/stream error, DynamoDB throttling, and Lambda concurrency alarms plus versioned artifact aliases and rollback guidance. The user reports manually deploying all AWS resources created so far; production provisioning is therefore user-reported, not independently verified. SNS subscription confirmation/delivery remain outstanding. API Lambda/API Gateway infrastructure and deployment are separate new P9-T6/P9-T7 work.

P9-T6/P9-T7 tracking update (2026-10-31): the user confirmed the dev region `eu-north-1`, Node.js 26 LTS, and existing buckets `rental-management-artifacts` and `rental-management-documents`. All Lambda runtimes now use `nodejs26.x`, and the AWS provider constraint/lock was upgraded to v6 to support it. Since no separate photos bucket was supplied, photos reuse the documents bucket; the reviewed plan used provisional dev CORS origin `http://localhost:5173`. The user reports applying the API configuration and supplied its endpoint, state list, and outputs. A read-only `/health` request initially returned HTTP 500, request ID `GH4NSjaDAi0EMsA=`. The provided Lambda init log showed `@node-rs/argon2-linux-x64-gnu` was missing. The packaging now explicitly copies that platform package, pnpm is configured to install Linux glibc x64 optional dependencies on the Windows build host, and `pnpm build` fails if the native binding is absent; ZIP inspection verified the `.node` binary is ELF x86_64. The API and authorizer Lambda concurrency is configured at 50/20. Local checks pass: `pnpm build`, `pnpm typecheck`, targeted ESLint, 23 auth repository tests, Terraform fmt/validate, and 6 mocked Terraform tests. A remediation plan was generated at `infra/terraform/api-dev-argon2-review.tfplan` (6 add, 12 change, 6 destroy; old content-hashed artifact objects are replaced). The user now reports that they applied the corrected artifact; the latest supplied state list includes the API/authorizer, routes, aliases, invoke permissions, and alarms. The corrected endpoint health check returned HTTP 200; an independent read-only GET returned `{"ok":true,"service":"rental-api","timestamp":"2026-10-31T19:33:02.433Z}` with request ID `GH9RUgXIAi0EMkg=`. No AWS mutation was performed here. P9-T7 remains in progress pending protected-route/authorization and operational smoke checks. Do not apply the remediation plan again.

P9-T6 batch (2026-10-31): API/authorizer Lambda resources use built artifacts, content-hashed stage-specific S3 keys, published versions and `live` aliases; least-privilege policies, HTTP API proxy/authorizer wiring, public health route, exact-origin CORS, 50/100 throttling, outputs, and API error/latency alarms are implemented. The API S3 permissions cover upload, HEAD verification, and download flows; admin health permissions are scoped to the table and worker queues/DLQs, with CloudWatch `GetMetricStatistics` on `*` because that operation does not support resource-level permissions. `allowed_origins` is required with no production-origin default. Local validation passed: `pnpm build`; `terraform fmt -check -recursive infra/terraform`; `terraform -chdir=infra/terraform validate -no-color`; `terraform -chdir=infra/terraform test -no-color` (6 passed); and `git diff --check`. A fresh remote-state-refreshing but non-mutating dev plan was prepared at `infra/terraform/api-dev-review.tfplan` for `eu-north-1`, stage `dev`, and provisional origin `http://localhost:5173`: 28 to add, 8 to change, and 4 to destroy. The four replacements remove old content-hashed ZIP object keys for the stream aggregator and three workers after uploading new keys; the four existing worker/stream Lambdas are updated in place to `nodejs26.x`. At the time this plan was generated, no apply had yet been reported and P9-T7 remained blocked pending user review/confirmation. The later user report records successful apply; see the subsequent P9-T7 update.

P9-T3 progress (2026-10-31): added `docs/production-cutover-runbook.md` and linked it from `docs/k6-load-testing.md`. The runbook documents deployment gates, read-only smoke checks, alarm response, rollback, and on-call handoff. Reconciled its alarm statements with `infra/terraform/alarms.tf`: worker/stream errors, DLQ depth, DynamoDB throttles, and Lambda concurrency alarms route to SNS with an optional email subscription. Production provisioning, subscription confirmation, notification delivery, and the API deployment/API-specific alarm path remain unverified. P9-T6/P9-T7 track the API path separately; the runbook exercise remains under P9-T5. No AWS mutation or deployment was performed.

P9-T3 verification (2026-10-31): `pnpm exec vitest run test/unit/k6-smoke.test.ts --reporter=dot` passed (1 file, 3 tests); the runbook structure/readiness/reference check and `git diff --check` passed. No AWS request, mutation, apply, deployment, or production exercise was run.

## Current verification snapshot

P8-T2 local progress (2026-10-31): per-IP limits are configured for registration (5/hour), login (10/minute), refresh (60/minute), MFA verify (20/hour), MFA resend (10/hour), password-forgot (10/hour), and password-reset (20/hour); service limits additionally include MFA verify/resend per user and password-forgot at 3/hour per email. API responses include `Cache-Control: no-store`. MFA/password-reset challenge state is persisted under the spec's OTP purpose keys with five-minute TTLs and atomic five-attempt challenge bounds. MFA and reset codes are enqueued via notification jobs. Password-forgot returns `{sent:true}` regardless of account existence; reset accepts `{email, code, newPassword}` and returns 204. A DynamoDB transaction atomically changes the password and consumes the valid reset challenge; unknown-account and missing-challenge outcomes both return `401 INVALID_OTP`. The combined auth/attachment focused suite passed (8 files / 48 tests), as did targeted ESLint, `pnpm typecheck`, and `git diff --check`. P8-T2 remains incomplete: API Gateway throttling is to be wired and tested as part of P9-T6; no ZAP baseline has run. No AWS calls, apply, or deployment were performed.

P8-T2 continuation (batch 7, 2026-10-31): delegated a continuation to persist OTPs and add API throttling only if a safe API Terraform integration existed. The agent was cancelled before returning a result; no implementation or validation was produced. The card remains in progress, with no active worker.

P9-T1 verification (2026-10-31): local loopback-only k6 smoke/load scenario and profile assertions are complete. `pnpm exec vitest run test/unit/k6-smoke.test.ts --reporter=dot` passed (3 tests); targeted ESLint and both `k6 inspect` profiles passed. The local API was unavailable at `127.0.0.1:3000`, so no measured load result was recorded. No AWS action was performed.

P9-T2 current verification (2026-10-31): `terraform fmt -check -recursive infra/terraform`, `terraform -chdir=infra/terraform validate`, and mocked `terraform -chdir=infra/terraform test` passed (4/4). Terraform defines worker/DLQ, stream/Lambda error, DynamoDB throttle, and Lambda concurrency alarms plus an SNS topic, content-hash artifacts, and versioned worker aliases. The user reports manually deploying the stack and supplied state lists. The earlier list covered the DynamoDB table, worker/stream Lambdas and mappings, queues/DLQs, SNS topic, alarms, and aliases. A later report adds the API Gateway, API/authorizer Lambdas, routes, permissions, and API alarms. These are external/user-reported deployment results, not independently verified; no SNS email subscription or alarm delivery confirmation was provided. P9-T2 remains incomplete.

P9-T3 current status: runbook written, linked, and reconciled with the current Terraform alarm resources. The user-reported deployment of resources in Terraform state is now noted; API deployment and SNS email confirmation/notification delivery remain unverified. The runbook structure/readiness/reference check and `git diff --check` passed, as did the k6 test (1 file, 3 tests). Production exercise remains outside this card and blocked under P9-T5 until P9-T7, a confirmed alarm route, and an approved exercise window are available.

P9-T7 health verification (2026-10-31): after the reported Linux Argon2 binding fix, the user shared a successful `curl` response from `/health`; an independent GET to `https://ygo6i4le3f.execute-api.eu-north-1.amazonaws.com/health` returned HTTP 200 with `{"ok":true,"service":"rental-api","timestamp":"2026-10-31T19:33:02.433Z}` and API Gateway request ID `GH9RUgXIAi0EMkg=`. Security headers and `Cache-Control: no-store` were present. This verifies health only; protected-route authorization, throttling, CORS behavior, log/alarm checks remain outstanding. Keep P9-T7 in progress. Do not apply `api-dev-argon2-review.tfplan` if the corrected artifact has already been deployed.

Latest validation (2026-10-27): registered-account payment flow and per-endpoint account-isolation/domain coverage passed `pnpm typecheck`, 30 focused tests, targeted ESLint, and `git diff --check`. These tests did not connect to AWS/DynamoDB. Earlier tenant/property validations, user-reported dev auth verification, Terraform validation, and the 17-pattern local DynamoDB run are recorded above. No Git push was performed.

P7-T1 verification (2026-10-31): added representative payment/lease report fixtures and integration coverage that runs the report processor, account-scoped repository queries, streaming XLSX writer, and generated workbook reader. Verified property/lease/status filters, inclusive date bounds, empty workbook output, account isolation, and Query-only (no Scan) access. Corrected the XLSX centimes header spacing defect exposed by formatting assertions. `pnpm exec vitest run test/integration/report-processor.integration.test.ts --reporter=dot` passed (1 file, 3 tests), targeted ESLint passed, and scoped `git diff --check` passed. `pnpm typecheck` is currently blocked by a syntax error in the concurrently changed `src/modules/document/routes.ts` (line 83); no AWS/DynamoDB or S3/SQS services were contacted.

Batch status (2026-10-28): delegated P4-T2, P4-T3, and P6-T2 to the backend implementation agent. P4-T2 and P6-T2 implementation/test evidence is recorded above. The user reports deploying P4-T3 to dev and confirms all verification checks passed on 2026-10-28. P4-T3 is complete based on user-reported external verification; the assistant did not inspect the AWS account.

Batch status (2026-10-31): P4-T1, P6-T3, and P7-T2 were delegated in parallel. P6-T3 is complete and repository-verified: bundled Inter, Noto Sans, and Noto Naskh Arabic variable fonts with SIL OFL 1.1 notices, embedded them as base64 `@font-face` rules, and verified PDF-worker packaging. `pnpm exec vitest run test/unit/pdf-documents.test.ts` (5 tests), targeted ESLint, `pnpm typecheck`, `pnpm build:pdf`, and scoped `git diff --check` passed; the build copied the three font files and notices into the ZIP. No AWS resources were changed.

P4-T1 is blocked: inspection found no API-handler Lambda or EventBridge Scheduler resource in Terraform, no direct signed-invocation/HMAC validation path, and no global bounded all-account overdue processor with the required 5,000-payment cap/truncation log. No code change or test run was made. P7-T2 remains in progress: the added local report-processor benchmark passed for 10,000 XLSX rows in 409 ms on Windows x64/Node v24.13.1 (20 mocked query pages; 462,615 output bytes; DynamoDB/S3/SQS mocked). Focused test, typecheck, targeted ESLint, and diff check passed. This does not verify the deployed worker’s 1024 MB/120 s configuration or real service latency. User approval is required before creating live test jobs/data and export artifacts. No AWS infrastructure mutation or deployment is authorized.

Batch status (2026-10-31, batch 2): delegated P5-T1, P5-T2, and P6-T4 in parallel. P5-T1 covers DynamoDB Streams infrastructure and stream-aggregator connection; P5-T2 covers summary-backed dashboard/report endpoints; P6-T4 is unblocked by completed P6-T2/P6-T3 and covers the Arabic PDF fixture and shaped-glyph assertion. No Terraform apply, AWS mutation, or deployment is authorized.

Batch 2 verification (2026-10-31): P5-T1 and P5-T2 are complete. P5-T1's active-stage stream Lambda, DLQ, scoped IAM, and mapping configuration passed `terraform fmt -check infra/terraform`, `terraform -chdir=infra/terraform validate`, and mocked `terraform -chdir=infra/terraform test` (2 runs). P5-T2's account-scoped dashboard and summary APIs passed `pnpm exec vitest run test/unit/dashboard-repository.test.ts test/unit/dashboard-service.test.ts test/unit/dashboard-routes.test.ts test/unit/app.test.ts --reporter=dot` (4 files, 29 tests), `pnpm typecheck`, targeted ESLint, and `git diff --check`. Neither task was deployed or applied to AWS.

P6-T4 is complete: real Chromium PDF rendering and PDF.js extraction verified the embedded Noto Naskh Arabic font loaded and extracted the expected shaped glyph sequence. `$env:PUPPETEER_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'; pnpm exec vitest run test/unit/pdf-arabic-render.test.ts test/unit/pdf-documents.test.ts` passed (2 files, 6 tests), as did `pnpm typecheck`, targeted ESLint, and `git diff --check`. Linux CI with bundled Chromium remains unverified.

Batch status (2026-10-31, batch 3): delegated P5-T3, P6-T1, and P7-T1 in parallel. P5-T3 follows completed stream and dashboard foundations; P6-T1 covers secure document presign/upload/download APIs; P7-T1 covers representative report fixtures and integration coverage for filters, date ranges, and empty results. No AWS apply, mutation, or deployment is authorized.

Batch status (2026-10-31, batch 4): delegated P8-T1, P8-T2, and P9-T1 in parallel. These are the next ready cards after P5/P6/P7 milestone work and remain repository-local until the security and load-test deliverables are implemented and validated. No AWS apply or deployment is authorized.

Batch status (2026-10-31, batch 5): delegated P9-T2 and P9-T3 in parallel. The tasks are in progress and remain repository-local until the production Terraform verification and operational runbook are fully validated; no AWS apply or deployment is authorized.

Batch status (2026-10-31, batch 6): delegated P8-T1, P8-T2, and P9-T1 in parallel. P8-T1 and P9-T1 are locally complete; P8-T2 remains incomplete as recorded above. The live k6 measurement did not run because the local API was unavailable. No AWS apply or deployment was performed.

Batch status (2026-10-31, batch 7): P8-T2 continuation was attempted after the user confirmed no other batch was active, but the worker was cancelled before returning implementation or validation. No changes were received; P8-T2 remains the next active implementation task.

Batch status (2026-10-31, batch 8): continued P8-T2's security implementation, P6-T1's API authorization documentation, and P5-T3's local DynamoDB replay verification in parallel. P6's documentation and focused tests passed, while ticket attachment confirmation/object verification/metadata persistence remain. P5-T3 DynamoDB Local replay passed (1 integration test); its mocked p95 is not end-to-end/deployed latency. P8-T2's follow-up implementation and focused validation passed; only API Gateway throttling/deployment and ZAP remain. No AWS changes or deployment were authorized.

Batch status (2026-10-31, batch 9): P6-T1 maintenance-attachment confirmation, account-scoped ticket/key checks, S3 object metadata verification, and ticket metadata persistence passed focused tests (4 files / 17 tests). P8-T2 reset concurrency was corrected with an atomic password/OTP DynamoDB transaction and uniform invalid-reset responses. Independently verified combined focused tests passed (8 files / 48 tests), as did `pnpm typecheck`, targeted ESLint, and `git diff --check`. P6-T1 is locally complete; P8-T2 remains open for API Gateway throttling/deployment and ZAP. No AWS/S3 live calls, deployment, or apply occurred.

External deployment report (2026-10-31): the user reports manually deploying the AWS resources created so far. The supplied `terraform -chdir=infra/terraform state list` includes the DynamoDB table, stream aggregator and workers, event source mappings, SQS queues/DLQs, SNS alarm topic, CloudWatch alarms, Lambda aliases, artifact objects, and IAM/log resources. The assistant did not query AWS or inspect the state directly. The supplied list does not contain API Lambda/API Gateway or `aws_sns_topic_subscription.alarm_email`; do not infer those are provisioned/confirmed.

P4-T3/P4-T4 dev verification (2026-10-28): user reports the deployment and all requested verification checks passed, including the dev SQS-to-worker-to-document flow and quittance idempotency. P4-T3 and P4-T4 are complete based on user-reported external verification; the assistant did not inspect the AWS account or run a live queue-to-worker test.

P4-T2 verification (2026-10-27): implemented the owner-authenticated quittance route and idempotent PDF job/SQS producer. `pnpm exec vitest run test/unit/payment-routes.test.ts test/unit/enqueue-pdf.test.ts` passed (8 tests); `pnpm typecheck` passed; targeted ESLint passed. No live AWS/SQS run was performed.

## Next recommended work

1. Verify one protected API route succeeds with valid authorization and rejects a request without authorization; then check configured throttling/CORS/log/alarm behavior.
2. Do not apply `infra/terraform/api-dev-argon2-review.tfplan`; the user reports the corrected artifact is deployed. If further changes are needed, generate and review a fresh plan.
3. Run P8-T3 ZAP and P9-T4 load acceptance after the remaining API smoke checks pass and an approved target/window is available; P9-T5 remains gated on a confirmed alarm route and exercise window.
4. Resolve P4-T1's remaining signed direct-invocation and bounded all-account overdue-processing prerequisites before wiring the EventBridge schedule.
5. Continue P5-T3 only when a representative end-to-end/deployed dashboard latency target is available; DynamoDB Local replay is verified. Obtain approval before P7-T2's deployed-worker benchmark or any further AWS mutations.
