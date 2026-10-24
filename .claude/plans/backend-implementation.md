# Backend Implementation Status

This tracker follows the phase sequence and exit criteria in [Backend Specification §20](../.claude/backend.md#20-implementation-phases). Work has also been done ahead of the sequence on async workers, aggregation, PDF generation, and reports; those early components do not mean their phases are complete.

**Overall status: P1 — Data layer in progress.** P0 exit criteria are verified; no later phase currently meets all of its specification exit criteria. Items are checked only when the corresponding deliverable is implemented and verified; items not checked are outstanding.

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

**Status: In progress — local access-pattern tests pass; dev S3 backend is initialized and plan reviewed**

- [x] Add account-scoped key builders and shared repository operations with account/GSI key checks.
- [x] Add account-scoped job repository operations and conditional job transitions.
- [x] Define and implement the property domain item/repository contract used by the API.
- [x] Remove the duplicate root-level property routes now that the property module owns the `/properties` route mount.
- [ ] Provision the table and both GSIs through Terraform.
- [x] Run DynamoDB Local integration tests covering every §7.4 access pattern.
- [ ] Meet the phase exit criteria: table and GSIs are provisioned; every specified access pattern is proven by a test.

Progress: Terraform configuration for the table and both GSIs is implemented but has not been applied to AWS. The dev S3 backend is initialized against the approved `rental-management-terraform` bucket in `eu-north-1`; dev and prod have separate state keys and native S3 lockfiles. The local-only integration suite passes against DynamoDB Local and exercises all 17 §7.4 patterns, including GSI queries followed by `BatchGetItem`. A read-only `DescribeTable` in `eu-north-1` returned `ResourceNotFoundException` for `rental-app-main`. The fresh dev plan proposes only the creation of that table: one add, zero changes, zero destroys.

## P2 — Auth

**Specification deliverable:** registration, login, MFA, refresh/logout, JWT, session model, and lockout.

**Status: In progress — route, crypto, and repository scaffolding exist; the auth data access is still demo-backed and the refresh/session flow is only partially implemented in-memory**

- [x] Add an API Gateway JWT authorizer entry point that validates RS256 claims and reads the public key from SSM.
- [x] Add Argon2 password hash/verification helpers and RS256 access-token signing/verification scaffolding.
- [x] Replace the service-level demo `Map` with a repository abstraction so auth reads/writes are centralized in a single storage boundary.
- [x] Require verified bearer tokens on the property API and derive the account context from the JWT rather than accepting caller-supplied `x-account-id` values.
- [x] Replace the runtime-generated key pair with a config/SSM-backed key selection path so signing and verification can use configured RSA keys instead of a fresh in-memory key every boot.
- [x] Implement the production-style registration and credential lookup model as a clear account/user/email-directory boundary using the DynamoDB transaction pattern when `TABLE_NAME` is configured, with a safe local fallback for dev/test bootstraps.
- [x] Add a Dynamo-backed session lifecycle path for configured auth tables, including create, lookup, rotation, and revoke operations with local fallback for dev/test bootstrap.
- [ ] Replace the in-memory demo user/store and runtime-generated signing key; do not treat the current auth scaffold as production authentication.
- [x] Implement MFA challenge and verification flow, including challenge issuance, verification, and resend path support in the service and routes.
- [x] Implement access/refresh token issuance, rotation, logout, session revocation, and reuse detection.
- [x] Implement login lockout and failed-attempt tracking.
- [x] Implement single-session enforcement for super-admin sessions with authoritative session lookup in the auth middleware; full repository-backed persistence remains a separate production-hardening task.
- [x] Ensure the auth service and middleware resolve the repository lazily per request so session checks follow the active runtime configuration rather than a stale module-level singleton.
- [x] Harden the in-memory session model to track session lifecycle metadata (`issuedAt`, `expiresAt`, `revokedAt`) and consumed refresh-token state per family.
- [x] Integrate verified claims and authoritative session checks into API request context; remove caller-supplied account identity.
- [x] Meet the phase exit criteria: token-reuse detection passes and super-admin single-session enforcement is tested.

### Verification snapshot
- Focused auth tests pass: `pnpm vitest run test/unit/app.test.ts test/unit/auth-repository.test.ts`.
- TypeScript check passes: `pnpm typecheck`.
- Lint passes: `pnpm lint`.

## P3 — Core CRUD

**Specification deliverable:** property, tenant, lease, and payment modules plus payment schedule generation.

**Status: Not started — route skeletons are not domain CRUD**

- [ ] Implement property CRUD, validation, ownership, and soft-delete constraints.
- [ ] Implement tenant CRUD and tenant-lease relationships.
- [ ] Implement lease lifecycle, validation, and property/tenant constraints.
- [ ] Implement payment schedule generation and payment status transitions.
- [ ] Add account-isolation and domain tests for every endpoint.
- [ ] Meet the phase exit criteria: authenticated end-to-end flow from registration through property, tenant, lease, and generated payment schedule.

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

Latest validation (2026-10-24): `terraform init -input=false -backend-config backend.dev.hcl` succeeded and initialized the dev remote S3 backend. `terraform plan -input=false -var="stage=dev"` proposes `1 to add, 0 to change, 0 to destroy`: create `rental-app-main` with GSI1 (ALL), GSI2 (KEYS_ONLY), PITR, TTL, AWS-owned-key encryption, and NEW_AND_OLD_IMAGES streams; dev deletion protection is disabled. A read-only `DescribeTable` in `eu-north-1` returned `ResourceNotFoundException`. No apply was run. The local DynamoDB integration run passed all 17 §7.4 patterns; `pnpm typecheck` and `pnpm test` (59 unit tests) passed previously. No Git push was performed.

## Next recommended work

1. Review the dev plan above and explicitly approve or decline the proposed table creation before any `terraform apply`.
2. After an approved apply, verify the table and both GSIs in `eu-north-1`, then close the P1 provisioning item and phase exit gate.
3. Initialize the separate prod backend and plan independently only when production deployment is requested.
