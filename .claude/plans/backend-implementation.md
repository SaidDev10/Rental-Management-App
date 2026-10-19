# Backend Implementation Status

This tracker follows the phase sequence and exit criteria in [Backend Specification §20](../.claude/backend.md#20-implementation-phases). Work has also been done ahead of the sequence on async workers, aggregation, PDF generation, and reports; those early components do not mean their phases are complete.

**Overall status: P0 — Foundations in progress.** No phase currently meets all of its specification exit criteria. Items are checked only when the corresponding deliverable is implemented and verified; items not checked are outstanding.

## P0 — Foundations

**Specification deliverable:** repository scaffold, config, logger, error taxonomy, base repository, ESLint, TypeScript configuration, local development stack, and CI pipeline.

**Status: In progress**

- [x] Create the pnpm project scaffold, TypeScript configuration, ESLint configuration, and unit-test runner.
- [x] Add the Hono app, `/health` route, API Lambda adapter, shared logger, and shared error types.
- [x] Add initial DynamoDB client, key builders, and account-scoped repository primitives.
- [x] Add a Docker Compose development stack for DynamoDB Local and LocalStack, example local AWS endpoint settings, and infra up/down scripts.
- [x] Complete and validate application configuration for the API, authorizer, and all worker roles; parse the API CORS allowlist from configuration.
- [x] Start DynamoDB Local and LocalStack and verify `pnpm dev` with the local AWS endpoint configuration.
- [x] Add CircleCI that installs from the frozen pnpm lockfile and runs typecheck, lint, unit tests, and Lambda builds.
- [ ] Meet the phase exit criteria: `pnpm dev` serves `/health`; lint passes; CI passes.

## P1 — Data layer

**Specification deliverable:** all item types, key builders, repositories, DynamoDB Local integration tests.

**Status: In progress — foundations only**

- [x] Add account-scoped key builders and shared repository operations with account/GSI key checks.
- [x] Add account-scoped job repository operations and conditional job transitions.
- [x] Define and implement the property domain item/repository contract used by the API.
- [x] Remove the duplicate root-level property routes now that the property module owns the `/properties` route mount.
- [ ] Provision the table and both GSIs through Terraform.
- [ ] Add DynamoDB Local integration tests covering every §7.4 access pattern.
- [ ] Meet the phase exit criteria: table and GSIs are provisioned; every specified access pattern is proven by a test.

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

Latest validation: `pnpm vitest run test/unit/app.test.ts` and `pnpm typecheck` passed after adding lockout logic, refresh-token rotation, and replay/logout rejection coverage. The auth flow now enforces a 5-attempt lockout and keeps session rotations working in the app layer, but the implementation still remains demo-backed and incomplete for the production spec: the active session is still local-memory state rather than a fully persisted repository model, MFA and super-admin single-session enforcement remain outstanding, and the broader Terraform/AWS integration and security gates are not complete. Re-run the commands after further code changes; update this snapshot only with fresh results.

## Next recommended work

1. Replace the remaining demo-backed auth state with a true repository-backed session model and persist active session state for production use.
2. Implement MFA and lockout in the auth flow, then add super-admin single-session enforcement with authoritative session checks.
3. Finish P1 repositories and DynamoDB Local integration tests.
4. Continue P3 core CRUD once the auth boundary is production-safe.
