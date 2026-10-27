# Backend Implementation Status

This tracker follows the phase sequence and exit criteria in [Backend Specification §20](../.claude/backend.md#20-implementation-phases). Work has also been done ahead of the sequence on async workers, aggregation, PDF generation, and reports; those early components do not mean their phases are complete.

**Overall status: P2 — Auth complete; P3 — Core CRUD complete; P4 — Async in progress.** P0 through P3 exit criteria are verified; no later phase currently meets all of its specification exit criteria. Items are checked only when the corresponding deliverable is implemented and verified; items not checked are outstanding.

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

**Status: In progress — worker foundation implemented ahead of the API**

- [x] Add account-scoped job state transitions, conditional claims, retry handling, and terminal failure handling.
- [x] Add validated SQS payloads, partial-batch processing, and concrete PDF/report/notification worker processors.
- [x] Add PDF output persistence and atomic job/document completion.
- [x] Add SES/WhatsApp adapters and reminder/overdue deduplication.
- [ ] Implement domain/API job producers, including the payment quittance endpoint and its authorization checks.
- [ ] Provision and configure the queues, DLQs, event-source mappings, templates, and IAM permissions.
- [ ] Exercise the complete SQS-to-worker-to-document flow against AWS-compatible integration services.
- [ ] Meet the phase exit criteria: `POST /payments/:id/quittance` produces a quittance and passes idempotency tests.

## P5 — Aggregation

**Specification deliverable:** stream aggregator, summary items, dashboard and summary-report APIs.

**Status: In progress — stream processor exists; API and measured performance are outstanding**

- [x] Add transactional event deduplication and account-scoped summary deltas.
- [x] Handle payment period changes by reversing the old month and applying the new month in one transaction.
- [x] Add unit tests for duplicate events, period changes, account-scoped summary keys, and unsupported entities.
- [ ] Provision and connect DynamoDB Streams with the specified images, retries, and failure destination.
- [ ] Add `/dashboard` and `/reports/summary` endpoints using the summary items.
- [ ] Add replay/integration coverage and measure dashboard p95.
- [ ] Meet the phase exit criteria: replay idempotency passes and dashboard p95 is measured.

## P6 — Documents & PDF breadth

**Specification deliverable:** S3 presigned flows, lease/police/condition-report templates, and Arabic rendering validation.

**Status: In progress — basic PDF generation exists; required breadth and validation remain**

- [x] Add Chromium-backed PDF generation for quittance and lease-related job types, with S3 output.
- [ ] Implement secure presigned upload/download flows and document API authorization.
- [ ] Complete and validate the lease, fiche de police, and état des lieux templates and document data.
- [ ] Bundle and verify the required fonts if/when Arabic templates are introduced.
- [ ] Add the Arabic PDF fixture test before shipping any Arabic template.
- [ ] Meet the phase exit criteria: the Arabic fixture renders and extracted text contains the expected shaped glyphs.

## P7 — Reports

**Specification deliverable:** report worker with XLSX/PDF export.

**Status: In progress — processor implemented; specification-scale verification remains**

- [x] Add monthly summary and payment/lease register report processing.
- [x] Add XLSX streaming upload and PDF export paths, report range/row guards, and document/job metadata.
- [ ] Add representative report fixtures and integration coverage for filters, date ranges, and empty results.
- [ ] Benchmark a 10,000-row export against the deployed worker configuration.
- [ ] Meet the phase exit criteria: a 10,000-row export completes within 120 seconds.

## P8 — Admin & hardening

**Specification deliverable:** admin routes, impersonation, audit log, rate limits, security headers, and ZAP scan.

**Status: Not started**

- [ ] Implement `/admin/*`, authorization, impersonation, and audit logging.
- [ ] Implement specified rate limits, security headers, and remaining security controls.
- [ ] Run OWASP ZAP baseline against the local/deployed API and address findings.
- [ ] Meet the phase exit criteria: ZAP baseline has no medium-or-higher findings.

## P9 — Load & cutover

**Specification deliverable:** k6 smoke, production Terraform, alarms, and runbook.

**Status: Not started**

- [ ] Add and run the k6 smoke/load scenario at the target concurrency.
- [ ] Provision and verify production Terraform, alarms, and deployment/rollback procedures.
- [ ] Write and exercise the operational runbook.
- [ ] Meet the phase exit criteria: p95 is at most 400 ms and p99 is at most 1,000 ms at 100 concurrent users.

## Current verification snapshot

Latest validation (2026-10-27): registered-account payment flow and per-endpoint account-isolation/domain coverage passed `pnpm typecheck`, 30 focused tests, targeted ESLint, and `git diff --check`. These tests did not connect to AWS/DynamoDB. Earlier tenant/property validations, user-reported dev auth verification, Terraform validation, and the 17-pattern local DynamoDB run are recorded above. No Git push was performed.

## Next recommended work

1. Wire the overdue-payment processor to its scheduled EventBridge invocation under P4.
2. Implement the payment quittance job producer and its authorization/idempotency tests under P4.
