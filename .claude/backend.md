# Backend Implementation Specification
## Rental Management App — API, Workers, and Data Layer

**Version:** 1.1
**Status:** Draft — for Engineering Lead review
**Prepared by:** Senior TypeScript Full-Stack Developer
**Date:** [Insert date]
**Companion documents:** Architecture v2.0, BRD v1.1, NFR v2.1
**Scope:** Backend only (API Lambda, async workers, DynamoDB data layer, Terraform interface)

**Revision history**

| Version | Change |
|---|---|
| 1.0 | Initial specification |
| 1.1 | Added §4.4 (module resolution and import style). Expanded §19.1 into the full ESLint flat config with readability and maintainability rule groups. Switched §19.2 to Bundler module resolution. Added §19.3 (import and export conventions). Renumbered §19.3–19.5 to §19.4–19.6. |

---

## 0. How to Read This Document

This spec is **normative**. Where Architecture v2.0 leaves an implementation decision open, this document closes it. Where this document contradicts Architecture v2.0, the contradiction is listed in [Section 2](#2-corrections--clarifications-required-to-architecture-v20) and must be ratified by the Solution Architect before implementation begins.

Conventions used:

- `MUST`, `SHOULD`, `MAY` follow RFC 2119.
- All code is TypeScript, `strict: true`.
- All examples assume `eu-west-1`.
- `ACCOUNT#<id>` means the literal string `ACCOUNT#` concatenated with the account ULID.

---

## 1. Implementation Goals and Guardrails

| Goal | Implementation consequence |
|---|---|
| Fit `<= $20/month` | No provisioned capacity, no X-Ray, no KMS CMKs, no VPC/NAT, EMF instead of `PutMetricData`, single API Lambda. |
| `<= 100` concurrent users | No sharding, no caching layer, no read replicas. DynamoDB on-demand only. |
| p99 `<= 1000 ms` | Zero network calls to other Lambdas in the request path. All cross-module calls in-process. |
| 1–3 person team | One package, one pipeline, one table, five application Lambdas plus the API Gateway authorizer. No microservice scaffolding. |
| 10-year retention | Soft deletes only for domain entities; TTL only for sessions, OTPs, idempotency records, and jobs. |
| Account isolation | Every PK/SK and every GSI key is `accountId`-prefixed. Enforced at the repository layer, not by convention. |

### 1.1 Non-negotiable rules

1. **No module may import another module's `repository.ts`.** Enforced by ESLint `no-restricted-imports` + `dependency-cruiser` in CI.
2. **No AWS SDK call may appear in `service.ts`.** Services are pure; all I/O goes through `repository.ts` or a `shared/` port.
3. **`accountId` MUST be derived from the verified JWT**, never from a path param, query param, or request body.
4. **No synchronous work may exceed 2.5 s of wall-clock time in `api-handler`.** Anything slower becomes an SQS job returning `202`.
5. **Every write path must be idempotent or explicitly documented as non-idempotent.**
6. **Relative imports and re-exports carry no file extension.** See [Section 4.4](#44-module-resolution-and-import-style) and [Section 19.3](#193-import-and-export-conventions).
7. **Named exports only**, except in `src/lambdas/**` and `*.config.*`. See [Section 19.3.2](#1932-named-exports-only).

---

---

## 3. Repository Layout

```
backend/
├── src/
│   ├── app.ts                          # Hono root app — route mounting only
│   ├── lambdas/
│   │   ├── api-handler.ts              # handle(app)
│   │   ├── authorizer.ts               # API Gateway Lambda authorizer
│   │   ├── pdf-worker.ts               # SQS consumer
│   │   ├── report-worker.ts            # SQS consumer
│   │   ├── notification-worker.ts      # SQS consumer  (see C-1)
│   │   └── stream-aggregator.ts        # DynamoDB Streams consumer
│   ├── middleware/
│   │   ├── request-context.ts
│   │   ├── logger.ts
│   │   ├── auth.ts
│   │   ├── account-scope.ts
│   │   ├── role-guard.ts
│   │   ├── audit.ts
│   │   └── idempotency.ts
│   ├── modules/
│   │   ├── auth/          { routes, service, repository, tokens, passwords, validators, types, index }
│   │   ├── account/
│   │   ├── user/
│   │   ├── property/
│   │   ├── tenant/
│   │   ├── lease/
│   │   ├── payment/
│   │   ├── document/
│   │   ├── maintenance/
│   │   ├── report/
│   │   ├── dashboard/
│   │   ├── job/
│   │   └── admin/
│   ├── shared/
│   │   ├── config/        # env parsing + SSM loader
│   │   ├── db/            # DynamoDB client, keys, base-repository, pagination, transactions
│   │   ├── events/        # domain event contracts + publisher
│   │   ├── errors/        # AppError taxonomy + HTTP mapping
│   │   ├── http/          # response helpers, problem+json
│   │   ├── ids/           # ULID generation, id prefixes
│   │   ├── logger/        # pino instance + redaction
│   │   ├── metrics/       # EMF emitter
│   │   ├── crypto/        # field-level encryption, hashing, HMAC
│   │   ├── pdf/           # template rendering + chromium pool
│   │   ├── notify/        # SES + Twilio ports and adapters
│   │   ├── sqs/           # producer + consumer harness (partial batch failure)
│   │   └── types/
│   ├── templates/         # Handlebars/React-Email HTML → PDF templates (fr, en, ar)
│   └── generated/         # build-time artifacts (openapi.json, event schema types)
├── test/
│   ├── unit/
│   ├── integration/       # dynamodb-local + localstack
│   └── fixtures/
├── scripts/
│   ├── seed-local.ts
│   └── verify-bundle-size.ts
├── esbuild.config.ts
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── .dependency-cruiser.cjs
└── package.json
```

**Rule:** `src/lambdas/*` MAY import only from `src/app.ts`, `src/shared/*`, and worker-specific modules. They MUST NOT contain business logic.

---

## 4. Toolchain and Dependencies

### 4.1 Runtime dependencies (pinned)

| Package | Version | Purpose |
|---|---|---|
| `hono` | `^4.13` | HTTP framework |
| `@hono/aws-lambda` | `^1.0` | Lambda adapter |
| `@hono/zod-validator` | `^0.7` | Request validation middleware |
| `zod` | `^4.0` | Schema validation |
| `@aws-sdk/client-dynamodb` | `^3` | DynamoDB low-level client |
| `@aws-sdk/lib-dynamodb` | `^3` | Document client + `marshall`/`unmarshall` |
| `@aws-sdk/client-s3` | `^3` | Documents/photos |
| `@aws-sdk/s3-request-presigner` | `^3` | Presigned upload/download |
| `@aws-sdk/client-sqs` | `^3` | Job enqueue |
| `@aws-sdk/client-sesv2` | `^3` | Transactional email |
| `@aws-sdk/client-ssm` | `^3` | Secret loading |
| `@aws-sdk/client-lambda` | `^3` | Impersonation context only |
| `pino` | `^9` | Structured logging |
| `ulid` | `^3` | Sortable IDs |
| `@node-rs/argon2` | `^2` | Password hashing (prebuilt `linux-x64-gnu`) |
| `@node-rs/bcrypt` | `^1` | Documented fallback |
| `jose` | `^6` | JWT sign/verify (RS256) |
| `@sparticuz/chromium` | `^138` | Headless Chromium for Lambda |
| `puppeteer-core` | `^24` | PDF rendering driver |
| `handlebars` | `^4` | HTML templates |
| `exceljs` | `^4` | Report export |
| `twilio` | `^5` | WhatsApp |
| `@sentry/aws-serverless` | `^9` | Error tracking |
| `aws-embedded-metrics` | `^4` | EMF metrics |

### 4.2 Native module handling (critical)

`@node-rs/argon2` and `@sparticuz/chromium` ship platform-specific binaries. In `esbuild.config.ts`:

```ts
export default {
  bundle: true,
  platform: 'node',
  target: 'node22',            // syntax target; runtime is nodejs26.x
  format: 'esm',
  outfile: 'dist/api-handler.mjs',
  external: ['@node-rs/argon2', '@node-rs/bcrypt', '@sparticuz/chromium', 'puppeteer-core'],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
};
```

Externals MUST be present in `node_modules` inside the deployment zip. The build script `scripts/verify-bundle-size.ts` fails CI if any unzipped artifact exceeds **220 MB** (Lambda limit 250 MB).

### 4.3 TypeScript 7 risk

Architecture §12 item 10 flags that `typescript-eslint` may not support TS 7. Mitigation:

- Typecheck with `tsgo --noEmit` (TS 7 native compiler) — this is the blocking gate.
- Lint with ESLint 9 flat config. If `typescript-eslint` cannot parse TS 7 syntax, pin it to the newest release declaring TS 7 support; if none exists, fall back to `oxlint` for type-unaware rules and keep `tsgo` as the correctness gate.
- Record the outcome as **ADR-012**.

### 4.4 Module resolution and import style

`tsconfig.json` uses `"moduleResolution": "Bundler"`, **not** `"NodeNext"`. This has one visible consequence for every file in the repository:

**Relative imports and re-exports MUST NOT carry a file extension.**

```ts
// Correct
import { propertyService } from '../property';
import { PaymentSchema } from './validators';
export { routes as paymentRoutes } from './routes';
export type { Payment } from './types';

// Forbidden — rejected by ESLint (`import/extensions`, §19.1)
import { propertyService } from '../property.ts';
import { propertyService } from '../property.js';
export { routes as paymentRoutes } from './routes.ts';
```

Rationale:

- `NodeNext` resolution requires the `.js` extension in the source file even though the file on disk is `.ts`. Every new contributor trips over it, and it produces import paths that do not exist in the repository — `import './foo.js'` in a directory containing only `foo.ts`.
- Every Lambda is bundled by esbuild before deployment, so Node's native ESM resolver never sees the source tree. The `NodeNext` extension requirement buys nothing at runtime.
- Extensionless paths match the mental model of every bundler-based TypeScript project (Vite, tsx, Next) and match the frontend, which uses the same convention. A developer moving between `frontend/` and `backend/` should not have to remember a different rule.

The rule is enforced twice: TypeScript's Bundler resolution rejects a `.ts` suffix unless `allowImportingTsExtensions` is explicitly enabled (it is not), and ESLint's `import/extensions` rule rejects `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, and `.jsx` on any relative path.

Package imports are unaffected. `import { Hono } from 'hono'` is correct; subpath exports declared by a package (`@aws-sdk/client-s3`) keep whatever the package specifies.

---

## 5. Configuration

### 5.1 Environment variables (Terraform-supplied)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `STAGE` | yes | `prod` | `dev` \| `prod` |
| `AWS_REGION` | yes | `eu-west-1` | Reserved by Lambda |
| `TABLE_NAME` | yes | `rental-app-main` | |
| `DOCUMENTS_BUCKET` | yes | `rental-app-documents-prod` | |
| `PHOTOS_BUCKET` | yes | `rental-app-photos-prod` | |
| `PDF_QUEUE_URL` | api, pdf | `https://sqs...` | |
| `REPORT_QUEUE_URL` | api, report | `https://sqs...` | |
| `NOTIFICATION_QUEUE_URL` | api, notif | `https://sqs...` | |
| `SES_FROM_ADDRESS` | notif | `no-reply@rental-app.ma` | |
| `SES_CONFIG_SET` | notif | `rental-app-tracking` | |
| `SSM_PARAM_PREFIX` | yes | `/rental-app/prod` | |
| `LOG_LEVEL` | no | `info` | Default `info` |
| `SENTRY_DSN` | no | — | Absent in dev |
| `TWILIO_MONTHLY_CAP` | notif | `500` | Message count cap |
| `ALLOWED_ORIGINS` | api | `https://app.rental-app.ma` | CSV |

### 5.2 Secrets (SSM Parameter Store `SecureString`)

| Parameter | Consumer |
|---|---|
| `${prefix}/jwt/private-key` | api-handler |
| `${prefix}/jwt/public-key` | api-handler |
| `${prefix}/field-encryption-key` | api-handler |
| `${prefix}/google/oauth-client-secret` | api-handler |
| `${prefix}/twilio/account-sid` | notification-worker |
| `${prefix}/twilio/auth-token` | notification-worker |
| `${prefix}/twilio/whatsapp-from` | notification-worker |
| `${prefix}/internal-job-key` | api-handler (scheduled jobs) |

Secrets are loaded **once per cold start** in `shared/config/secrets.ts`, cached in module scope, and never logged. Missing required secret → throw at init → Lambda init fails loudly (not at first request).

### 5.3 Config module

```ts
// src/shared/config/index.ts
import { z } from 'zod';

const EnvSchema = z.object({
  STAGE: z.enum(['dev', 'prod']),
  TABLE_NAME: z.string().min(1),
  DOCUMENTS_BUCKET: z.string().min(1),
  PHOTOS_BUCKET: z.string().min(1),
  PDF_QUEUE_URL: z.string().url(),
  REPORT_QUEUE_URL: z.string().url(),
  NOTIFICATION_QUEUE_URL: z.string().url(),
  SES_FROM_ADDRESS: z.string().email(),
  SSM_PARAM_PREFIX: z.string().startsWith('/'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ALLOWED_ORIGINS: z.string().transform((s) => s.split(',').map((v) => v.trim())),
  SENTRY_DSN: z.string().url().optional(),
});

export const config = EnvSchema.parse(process.env);
export type Config = typeof config;
```

Invalid config MUST fail at module load (cold start), not lazily.

---

## 6. Hono Application

### 6.1 Root app

```ts
// src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { requestContext } from './middleware/request-context';
import { loggerMiddleware } from './middleware/logger';
import { onError } from './shared/errors/on-error';
import { config } from './shared/config';

import { adminRoutes } from './modules/admin';
import { authRoutes } from './modules/auth';
import { dashboardRoutes } from './modules/dashboard';
import { documentRoutes } from './modules/document';
import { jobRoutes } from './modules/job';
import { leaseRoutes } from './modules/lease';
import { maintenanceRoutes } from './modules/maintenance';
import { paymentRoutes } from './modules/payment';
import { propertyRoutes } from './modules/property';
import { reportRoutes } from './modules/report';
import { tenantRoutes } from './modules/tenant';

export type AppEnv = {
  Variables: {
    requestId: string;
    traceId: string;
    user?: AuthenticatedUser;   // set by auth middleware
    accountId?: string;         // set by account-scope middleware
    role?: Role;
    logger: Logger;
    impersonating?: boolean;
  };
};

const app = new Hono<AppEnv>();

app.use('*', requestContext());
app.use('*', loggerMiddleware());
app.use('*', cors({
  origin: config.ALLOWED_ORIGINS,
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
  exposeHeaders: ['X-Request-Id', 'Retry-After'],
  credentials: true,
  maxAge: 600,
}));

app.get('/health', (c) => c.json({ status: 'ok', version: BUILD_VERSION }));

app.route('/auth', authRoutes);
app.route('/properties', propertyRoutes);
app.route('/tenants', tenantRoutes);
app.route('/leases', leaseRoutes);
app.route('/payments', paymentRoutes);
app.route('/documents', documentRoutes);
app.route('/maintenance', maintenanceRoutes);
app.route('/reports', reportRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/jobs', jobRoutes);
app.route('/admin', adminRoutes);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
app.onError(onError);

export { app };
```

```ts
// src/lambdas/api-handler.ts
import { handle } from '@hono/aws-lambda';
import * as Sentry from '@sentry/aws-serverless';

import { app } from '../app';

Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });

export const handler = Sentry.wrapHandler(handle(app), {
  captureTimeoutWarning: true,
  timeoutWarningLimitInSeconds: 5,   // 29s Lambda timeout
});
```

### 6.2 Middleware chain (authoritative order)

```
1. requestContext     → requestId (X-Request-Id or ULID), traceId, child logger
2. loggerMiddleware   → emits access log on completion; never throws
3. cors
4. auth               → verify JWT, populate user/accountId/role   (public routes skipped via allowlist)
5. accountScope       → assert accountId present; build scoped repo factory
6. roleGuard          → route-level role check
7. idempotency        → only on POST/PATCH routes declaring it
8. audit              → buffered; flushes on response for audited routes
9. route handler      → module sub-app
```

`errorHandler` is implemented as `app.onError`, not `app.use`, so it also catches errors thrown by other middleware.

**Public route allowlist** (bypass `auth`): `POST /auth/register`, `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/mfa/resend`, `POST /auth/refresh`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `GET /auth/google/callback`, `GET /health`.

### 6.3 Auth middleware

```ts
export const auth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const header = c.req.header('Authorization');

  if (!header?.startsWith('Bearer ')) {
    throw new UnauthenticatedError('Missing bearer token');
  }

  const claims = await verifyAccessToken(header.slice(7));   // jose, RS256, cached public key

  // Single-session enforcement for super_admin (Architecture §5.2)
  if (claims.role === 'super_admin') {
    const active = await sessionRepo.getActiveSession(claims.sub);

    if (!active || active.sessionId !== claims.sid) {
      throw new UnauthenticatedError('Session superseded');
    }
  }

  c.set('user', { id: claims.sub, email: claims.email });
  c.set('accountId', claims.account_id);
  c.set('role', claims.role);
  c.set('impersonating', claims.imp === true);

  await next();
};
```

### 6.4 Account-scope middleware

```ts
export const accountScope = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const accountId = c.get('accountId');

  if (!accountId) {
    throw new UnauthenticatedError('No account scope on request');
  }

  // Impersonation is strictly read-only (Architecture §5.2)
  if (c.get('impersonating') && c.req.method !== 'GET') {
    throw new ForbiddenError('Impersonation sessions are read-only');
  }

  c.set('repos', createScopedRepositories(accountId));

  await next();
};
```

`createScopedRepositories(accountId)` returns repository instances whose key builders **close over** `accountId`. A repository method that accepts a raw `PK` is not exposed.

### 6.5 Role guard

```ts
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const role = c.get('role');

  if (!role || !roles.includes(role)) {
    throw new ForbiddenError('Insufficient role');
  }

  await next();
};
```

Applied at mount time: `app.route('/admin', adminRoutes)` where `adminRoutes.use('*', requireRole('super_admin'))`.

### 6.6 Audit middleware

Audited routes declare an `audit` descriptor on the route definition:

```ts
auditRoutes.post('/admin/impersonate/:accountId', {
  action: 'ADMIN_IMPERSONATE',
  targetType: 'Account',
  targetIdFrom: 'param:accountId',
}, handler);
```

The middleware writes a single `AUDIT#` item **after** the response is produced, fire-and-forget via `waitUntil`-style promise (not awaited by the response path), but **before** the Lambda returns (Lambda freezes the event loop after return — so it MUST be awaited with a short budget):

```
PK = AUDIT#<accountId>
SK = <ISO8601>#<ULID>
{
  entityType: 'AuditLog',
  actorUserId, actorRole, action, targetType, targetId,
  ip, userAgent, requestId, outcome: 'success' | 'failure',
  metadata: { ... }   // redacted
}
```

Audit writes MUST NOT be able to fail the request. Wrap in try/catch and log on failure.

---

## 7. Data Layer

### 7.1 Table definition (Terraform contract)

| Setting | Value |
|---|---|
| Name | `rental-app-main` |
| PK | `PK` (S) |
| SK | `SK` (S) |
| Billing | `PAY_PER_REQUEST` |
| Stream | `NEW_AND_OLD_IMAGES` |
| PITR | enabled |
| TTL attribute | `ttl` |
| SSE | AWS-owned key |
| Deletion protection | `true` in prod |

**GSI1** — `GSI1PK` (S) / `GSI1SK` (S), projection `ALL`
**GSI2** — `GSI2PK` (S) / `GSI2SK` (S), projection `KEYS_ONLY`

> Note on GSI projections: `GSI1` is `ALL` because it serves the hottest navigation paths (property → leases → payments). `GSI2` is `KEYS_ONLY` to keep write amplification and storage cost down, at the price of one `BatchGetItem`. This matches Architecture §4.3.

### 7.2 Key builders

```ts
// src/shared/db/keys.ts
export const pk = {
  account: (a: string) => `ACCOUNT#${a}`,
  audit: (a: string) => `AUDIT#${a}`,
  session: (userId: string) => `SESSION#${userId}`,
  otp: (userId: string) => `OTP#${userId}`,
  system: () => `SYSTEM`,
};

export const sk = {
  meta: () => `META`,
  user: (id: string) => `USER#${id}`,
  property: (id: string) => `PROPERTY#${id}`,
  tenant: (id: string) => `TENANT#${id}`,
  lease: (id: string) => `LEASE#${id}`,
  payment: (id: string) => `PAYMENT#${id}`,
  document: (id: string) => `DOC#${id}`,
  ticket: (id: string) => `TICKET#${id}`,
  job: (id: string) => `JOB#${id}`,
  summary: (yyyyMm: string) => `SUMMARY#${yyyyMm}`,
  counterQuittance: () => `COUNTER#quittance`,
  counterWhatsapp: (yyyyMm: string) => `COUNTER#whatsapp#${yyyyMm}`,
  tenantLeaseLink: (tenantId: string, leaseId: string) => `LINK#TENANT#${tenantId}#LEASE#${leaseId}`,
  idempotency: (key: string) => `IDEMPOTENCY#${key}`,
  processed: (eventId: string) => `PROCESSED#${eventId}`,
  active: () => `ACTIVE`,
  usedRefreshToken: (tokenHash: string) => `USED#${tokenHash}`,
  otpPurpose: (purpose: string) => purpose,
  auditEntry: (iso: string, id: string) => `${iso}#${id}`,
};

export const gsi1 = {
  property: (a: string, propertyId: string) => ({
    GSI1PK: `ACCOUNT#${a}#PROPERTY#${propertyId}`,
  }),
  lease: (a: string, leaseId: string) => ({
    GSI1PK: `ACCOUNT#${a}#LEASE#${leaseId}`,
  }),
  tenant: (a: string, tenantId: string) => ({
    GSI1PK: `ACCOUNT#${a}#TENANT#${tenantId}`,
  }),
  tenantDirectory: (a: string) => ({
    GSI1PK: `ACCOUNT#${a}#ACCOUNT#${a}`,
  }),
};

export const gsi2 = {
  status: (a: string, status: string) => ({
    GSI2PK: `ACCOUNT#${a}#STATUS#${status}`,
  }),
  email: (a: string, email: string) => ({
    GSI2PK: `ACCOUNT#${a}#EMAIL#${email.trim().toLowerCase()}`,
  }),
};
```

### 7.3 Entity item contracts

All items extend:

```ts
export interface BaseItem {
  PK: string;
  SK: string;
  entityType: EntityType;
  accountId: string;
  status: string;
  schemaVersion: number;
  createdAt: string;          // ISO 8601 UTC
  updatedAt: string;          // ISO 8601 UTC
  createdBy?: string;         // userId
  updatedBy?: string;
  version: number;            // optimistic concurrency
  ttl?: number;               // epoch seconds — only on ephemeral entities
  deletedAt?: string | null;  // soft delete
  GSI1PK?: string; GSI1SK?: string;
  GSI2PK?: string; GSI2SK?: string;
}
```

**`schemaVersion` starts at `1`.** Migrations are handled by the read path: `migrateItem(entityType, item)` upgrades older shapes in memory and schedules a lazy write-back. See [Section 19.4](#194-schema-evolution).

#### 7.3.1 Account

| Field | Type | Notes |
|---|---|---|
| `PK` | `ACCOUNT#<id>` | |
| `SK` | `META` | |
| `entityType` | `'Account'` | |
| `name` | string | |
| `ownerEmail` | string | |
| `ownerName` | string | |
| `phone` | string | E.164 |
| `locale` | `'fr' \| 'en' \| 'ar'` | Default `fr` |
| `timezone` | string | Default `Africa/Casablanca` |
| `currency` | `'MAD'` | |
| `status` | `'active' \| 'disabled'` | BRD rule #15: deletion = `disabled` |
| `disabledAt` | string \| null | |

#### 7.3.2 User

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `USER#<id>` |
| `email` | string (lowercased) |
| `passwordHash` | string (Argon2id PHC string) |
| `passwordUpdatedAt` | string |
| `role` | `'owner' \| 'super_admin'` |
| `mfaEnabled` | boolean |
| `failedLoginAttempts` | number |
| `lockedUntil` | string \| null |
| `googleSub` | string \| null |
| `GSI2PK` / `GSI2SK` | `ACCOUNT#<id>#EMAIL#<email>` / `USER#<id>` |

#### 7.3.3 Property

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `PROPERTY#<id>` |
| `label` | string |
| `address` | `{ line1, line2?, city, postalCode?, country: 'MA' }` |
| `propertyType` | `'apartment' \| 'house' \| 'studio' \| 'commercial' \| 'other'` |
| `areaSqm` | number \| null |
| `rooms` | number \| null |
| `purchaseDate` | string \| null |
| `purchasePrice` | number \| null (centimes) |
| `notes` | string \| null |
| `photoKeys` | string[] (max 20 S3 keys) |
| `GSI2PK` / `GSI2SK` | `ACCOUNT#<id>#STATUS#<status>` / `PROPERTY#<id>` |

#### 7.3.4 Tenant

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `TENANT#<id>` |
| `firstName`, `lastName` | string |
| `sortName` | string (`lastName#firstName` normalized, for directory sort) |
| `email`, `phone` | string |
| `dateOfBirth` | string \| null |
| `idDocument` | `{ type: 'CIN'\|'passport', numberEnc: string, issuedAt?, expiresAt?, fileKey? }` — `numberEnc` is application-encrypted |
| `address` | address object \| null |
| `GSI1PK` / `GSI1SK` | `ACCOUNT#<id>#ACCOUNT#<id>` / `TENANT#<sortName>#<id>` |

#### 7.3.5 Lease

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `LEASE#<id>` |
| `propertyId` | string |
| `tenantIds` | string[] (primary first) |
| `startDate`, `endDate` | string (`YYYY-MM-DD`) |
| `rentAmount` | number (centimes MAD) |
| `chargesAmount` | number (centimes) |
| `depositAmount` | number (centimes) |
| `paymentDayOfMonth` | number (1–28) |
| `billingFrequency` | `'monthly' \| 'quarterly'` |
| `indexation` | `{ enabled: boolean, ratePct?: number, effectiveFrom?: string }` |
| `status` | `'draft' \| 'active' \| 'terminated' \| 'expired'` |
| `terminatedAt` | string \| null |
| `terminationReason` | string \| null |
| `GSI1PK` / `GSI1SK` | `ACCOUNT#<id>#PROPERTY#<propertyId>` / `LEASE#<startDate>#<id>` |
| `GSI2PK` / `GSI2SK` | `ACCOUNT#<id>#STATUS#<status>` / `<startDate>#<id>` |

#### 7.3.6 Payment

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `PAYMENT#<id>` |
| `leaseId`, `propertyId`, `tenantId` | string |
| `periodStart`, `periodEnd` | string |
| `dueDate` | string |
| `amountDue` | number (centimes) |
| `amountPaid` | number (centimes) |
| `paymentMethod` | `'cash' \| 'bank_transfer' \| 'cheque' \| 'other'` \| null |
| `paidAt` | string \| null |
| `status` | `'due' \| 'partial' \| 'paid' \| 'late' \| 'cancelled'` |
| `quittanceNumber` | number \| null |
| `quittanceDocId` | string \| null |
| `GSI1PK` / `GSI1SK` | `ACCOUNT#<id>#LEASE#<leaseId>` / `PAYMENT#<dueDate>#<id>` |
| `GSI2PK` / `GSI2SK` | `ACCOUNT#<id>#STATUS#<status>` / `<dueDate>#<id>` |

**Status transition rule:** `due → partial → paid`; `due|partial → late` (set by a daily EventBridge-triggered job — see §14.1); `* → cancelled` (owner only). Transitioning **into** `paid` or `partial` MUST update `GSI2PK`.

#### 7.3.7 Document

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `DOC#<id>` |
| `documentType` | `'lease' \| 'quittance' \| 'fiche_police' \| 'etat_des_lieux' \| 'invoice' \| 'id_document' \| 'other'` |
| `s3Bucket`, `s3Key` | string |
| `mimeType`, `sizeBytes`, `checksumSha256` | |
| `linkedEntityType` / `linkedEntityId` | `'Lease' \| 'Payment' \| 'Tenant' \| 'Property' \| 'MaintenanceTicket'` |
| `generatedBy` | `'upload' \| 'pdf-worker'` |
| `retentionClass` | `'standard' \| 'glacier-2y'` |
| `GSI1PK` / `GSI1SK` | `ACCOUNT#<id>#LEASE#<leaseId>` / `DOC#<documentType>#<createdAt>#<id>` |

#### 7.3.8 MaintenanceTicket

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `TICKET#<id>` |
| `propertyId`, `leaseId?` | string |
| `title`, `description` | string |
| `priority` | `'low' \| 'medium' \| 'high'` |
| `status` | `'open' \| 'in_progress' \| 'resolved' \| 'closed'` |
| `cost` | number \| null |
| `attachments` | `{ s3Key, mimeType, sizeBytes }[]` |
| `GSI2PK` / `GSI2SK` | `ACCOUNT#<id>#STATUS#<status>` / `<priority>#<createdAt>#<id>` |

#### 7.3.9 Job

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `JOB#<id>` |
| `jobType` | `'PDF_GENERATE' \| 'REPORT_EXPORT' \| 'NOTIFY'` |
| `status` | `'queued' \| 'processing' \| 'succeeded' \| 'failed'` |
| `payload` | discriminated union, see §11 |
| `attempts` | number |
| `resultS3Key` | string \| null |
| `resultDocumentId` | string \| null |
| `error` | `{ code, message, at }` \| null |
| `startedAt`, `finishedAt` | string \| null |
| `ttl` | epoch seconds (30 days after `finishedAt`) |

**This entity is the single source of truth for async work status and is exposed at `GET /jobs/:jobId`.**

#### 7.3.10 Summary (pre-aggregated)

| Field | Type |
|---|---|
| `PK` / `SK` | `ACCOUNT#<id>` / `SUMMARY#<yyyy-mm>` |
| `totalIncome` | number (centimes) |
| `totalExpenses` | number |
| `netYield` | number |
| `occupiedProperties` | number |
| `totalProperties` | number |
| `latePayments` | number |
| `paidPayments` | number |
| `openTickets` | number |
| `updatedAt` | string |

#### 7.3.11 Session / OTP / Idempotency / Processed

| Entity | PK | SK | TTL |
|---|---|---|---|
| Session | `SESSION#<userId>` | `ACTIVE` | none (explicit revoke) |
| Consumed refresh token | `SESSION#<userId>` | `USED#<tokenHash>` | until the session family's absolute expiry |
| OTP | `OTP#<userId>` | `<purpose>` (`LOGIN_MFA`, `PASSWORD_RESET`) | 5 min |
| Idempotency | `ACCOUNT#<id>` | `IDEMPOTENCY#<key>` | 24 h |
| Processed event | `ACCOUNT#<id>` | `PROCESSED#<eventId>` | 24 h |

Session item:

```ts
{
  PK: `SESSION#${userId}`, SK: 'ACTIVE', entityType: 'Session',
  sessionId, userId, accountId,
  refreshTokenHash,        // SHA-256 of the current opaque refresh token
  familyId,                // stable for the session's lifetime
  issuedAt, expiresAt,     // expiresAt is the family's absolute expiry
  device: { userAgent, ip },
  revokedAt: null,
}
```

Each successful rotation also writes a `ConsumedRefreshToken` item with `PK = SESSION#<userId>`, `SK = USED#<presentedTokenHash>`, `familyId`, and `ttl` set to the session family's absolute expiry. The marker contains no raw token. It remains available long enough to recognize replay of any token from that family.

### 7.4 Access pattern → implementation map

| # | Pattern | Implementation |
|---|---|---|
| 1 | Get account | `GetItem(PK=ACCOUNT#<id>, SK=META)` |
| 2 | List properties | `Query(PK=ACCOUNT#<id>, begins_with(SK,'PROPERTY#'))` |
| 3 | List tenants (sorted) | `Query(GSI1, GSI1PK=ACCOUNT#<id>#ACCOUNT#<id>, begins_with(GSI1SK,'TENANT#'))` |
| 4 | List leases | `Query(PK=ACCOUNT#<id>, begins_with(SK,'LEASE#'))` |
| 5 | List payments | `Query(PK=ACCOUNT#<id>, begins_with(SK,'PAYMENT#'))` |
| 6 | Leases for property | `Query(GSI1, GSI1PK=ACCOUNT#<id>#PROPERTY#<pid>)` |
| 7 | Payments for lease | `Query(GSI1, GSI1PK=ACCOUNT#<id>#LEASE#<lid>, begins_with(GSI1SK,'PAYMENT#'))` |
| 8 | Documents for lease | `Query(GSI1, GSI1PK=ACCOUNT#<id>#LEASE#<lid>, begins_with(GSI1SK,'DOC#'))` |
| 9 | Late payments | `Query(GSI2, GSI2PK=ACCOUNT#<id>#STATUS#late)` → `BatchGetItem` |
| 10 | Due payments | `Query(GSI2, GSI2PK=ACCOUNT#<id>#STATUS#due)` → `BatchGetItem` |
| 11 | Open tickets | `Query(GSI2, GSI2PK=ACCOUNT#<id>#STATUS#open)` → `BatchGetItem` |
| 12 | Monthly summary | `GetItem(PK=ACCOUNT#<id>, SK=SUMMARY#<yyyy-mm>)` |
| 13 | Quittance number | `UpdateItem ADD nextNumber :one` |
| 14 | Login by email | `GetItem(PK=SYSTEM, SK=EMAIL#<normalizedEmail>)`, then `GetItem(PK=ACCOUNT#<id>, SK=USER#<userId>)` |
| 15 | Claim email at registration | Transactional conditional `PutItem(PK=SYSTEM, SK=EMAIL#<normalizedEmail>)` with `attribute_not_exists(PK)` |
| 16 | Leases for tenant | `Query(PK=ACCOUNT#<id>, begins_with(SK,'LINK#TENANT#<tid>#LEASE#'))` → `BatchGetItem` |
| 17 | Jobs by status | `Query(GSI2, GSI2PK=ACCOUNT#<id>#STATUS#<jobStatus>)` → `BatchGetItem` |

### 7.5 Base repository

```ts
// src/shared/db/base-repository.ts
export abstract class BaseRepository<T extends BaseItem> {
  protected constructor(
    protected readonly client: DynamoDBDocumentClient,
    protected readonly tableName: string,
    protected readonly entityType: EntityType,
    private readonly accountId: string,
  ) {}

  protected abstract toDomain(item: Record<string, unknown>): T;
  protected abstract toItem(entity: T): Record<string, unknown>;

  async get(skValue: string): Promise<T | null> {
    const out = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { PK: pk.account(this.accountId), SK: skValue },
      ConsistentRead: false,
    }));

    if (!out.Item || out.Item.deletedAt) {
      return null;
    }

    return this.toDomain(migrateItem(this.entityType, out.Item));
  }

  async queryBySk(opts: {
    beginsWith?: string;
    limit?: number;
    cursor?: string;
    index?: 'GSI1' | 'GSI2';
    indexPk?: string;
    scanIndexForward?: boolean;
  }): Promise<Page<T>> { /* builds KeyConditionExpression, decodes cursor */ }

  async put(entity: T, opts?: { condition?: string }): Promise<void> { /* ... */ }

  async update(input: {
    skValue: string;
    set?: Record<string, unknown>;
    remove?: string[];
    add?: Record<string, number>;
    condition?: string;
    expectedVersion?: number;
  }): Promise<T> { /* builds UpdateExpression, always SET updatedAt, ADD version :one */ }

  async softDelete(skValue: string, actorId: string): Promise<void> { /* ... */ }
}
```

**Repository invariants:**

- `PK` is never a parameter of a public method. It is always `pk.account(this.accountId)`.
- `version` is incremented on every `update`.
- `updatedAt` is always overwritten with `new Date().toISOString()`.
- `deletedAt` items are filtered out of all query results unless `includeDeleted: true` is passed by an admin path.

### 7.6 Pagination

```ts
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// Cursor = base64url(JSON.stringify(LastEvaluatedKey))
export const encodeCursor = (lek?: Record<string, unknown>) =>
  lek ? Buffer.from(JSON.stringify(lek)).toString('base64url') : null;

export const decodeCursor = (cursor?: string) =>
  cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined;
```

Default page size **25**, max **100**. `limit` above 100 is clamped, not rejected.

### 7.7 Optimistic concurrency

Every `update` accepts `expectedVersion`. If supplied, the repository adds:

```
ConditionExpression: #version = :expectedVersion AND attribute_not_exists(deletedAt)
```

On `ConditionalCheckFailedException` the repository throws `ConflictError` with code `CONFLICT_VERSION_MISMATCH`. Clients retry after re-reading.

### 7.8 Transactions

`TransactWriteItems` is used for exactly these multi-item invariants:

| Invariant | Items |
|---|---|
| Create lease + tenant links | `LEASE#<id>`, N × `LINK#TENANT#…#LEASE#<id>` |
| Record payment + summary delta (fallback path only) | `PAYMENT#<id>`, `SUMMARY#<yyyy-mm>` |
| Rotate refresh token | Conditional update of `SESSION#<userId>/ACTIVE` plus conditional put of `USED#<presentedTokenHash>` |
| Revoke session after confirmed refresh-token replay | Update `SESSION#<userId>/ACTIVE` plus `AUDIT#<accountId>` security event, conditioned on the consumed-token marker existing |
| Finalize PDF job | `JOB#<id>` update + `DOC#<id>` put |
| Aggregate event (dedupe + summary) | `PROCESSED#<eventId>`, `SUMMARY#<yyyy-mm>` |

DynamoDB transactions cap at **100 items** and **4 MB**. The lease-creation transaction is therefore limited to 99 co-tenants — validated in `lease/validators.ts`.

---

## 8. Module Specifications

Each module exports exactly one public surface from `index.ts`:

```ts
export { routes as propertyRoutes } from './routes';
export { propertyService } from './service';
export type { Property, CreatePropertyInput } from './types';
```

`repository.ts`, `validators.ts`, and `types.ts` are **not** re-exported.

### 8.1 `auth`

**Routes**

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/auth/register` | public | `{ accountName, ownerName, email, password, phone, locale? }` | `201 { user, account }` | `409 EMAIL_TAKEN`, `400 VALIDATION_ERROR` |
| POST | `/auth/login` | public | `{ email, password }` | `200 { accessToken, user }` + refresh cookie, **or** `202 { mfaRequired: true, challengeToken }` | `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED`, `403 ACCOUNT_DISABLED` |
| POST | `/auth/mfa/verify` | public | `{ challengeToken, code }` | `200 { accessToken, user }` + cookie | `401 INVALID_OTP`, `410 OTP_EXPIRED`, `429 OTP_ATTEMPTS_EXCEEDED` |
| POST | `/auth/mfa/resend` | public | `{ challengeToken }` | `202 { sent: true }` | `429 OTP_RATE_LIMITED` |
| POST | `/auth/refresh` | cookie | — | `200 { accessToken }` + rotated cookie | `401 INVALID_REFRESH`, `401 SESSION_REVOKED` |
| POST | `/auth/logout` | bearer | — | `204` | — |
| POST | `/auth/password/forgot` | public | `{ email }` | `202 { sent: true }` (always, to prevent enumeration) | — |
| POST | `/auth/password/reset` | public | `{ email, code, newPassword }` | `204` | `401 INVALID_OTP` |
| GET | `/auth/me` | bearer | — | `200 { user, account }` | `401` |
| GET | `/auth/google/authorize` | public | — | `302` to Google | — |
| GET | `/auth/google/callback` | public | — | `302` to SPA with `#access_token` | `401 OAUTH_FAILED` |

Registration normalizes the email and transactionally creates the account, user, and `SYSTEM/EMAIL#<normalizedEmail>` directory item. The directory put is conditional on the key not already existing; a collision returns `409 EMAIL_TAKEN`. Email is globally unique across owners and Super Admin users.

**JWT contract**

```ts
type AccessClaims = {
  sub: string;          // userId
  account_id: string;
  role: 'owner' | 'super_admin';
  email: string;
  sid: string;          // sessionId — used for single-session enforcement
  imp?: boolean;        // impersonation
  iat: number;
  exp: number;          // iat + 900
  jti: string;
  iss: 'rental-app';
  aud: 'rental-app-api';
};
```

Signed with **RS256** using the SSM private key. Public key cached in module scope and used by both the API Gateway authorizer and Hono middleware.

**Refresh token contract**

- Opaque 32-byte random, base64url-encoded. **Not** a JWT.
- The current token is stored as `refreshTokenHash = sha256(token)` in the `SESSION#<userId>/ACTIVE` item. Only hashes are persisted.
- Cookie: `__Host-rt`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/auth`, `Max-Age=2592000`.
- Rotation: every `/auth/refresh` conditionally replaces the current hash and writes a `USED#<presentedHash>` marker in the same transaction. `familyId` stays stable; `expiresAt` is the family's absolute expiry.
- On a failed conditional transaction, check for the presented hash's consumed marker. If present, transactionally revoke the session and write a `SecurityEvent` audit item, then return `401 SESSION_REVOKED`. If absent, return `401 INVALID_REFRESH` without revoking the session. Raw refresh tokens are never stored or logged.

**Lockout**

- `failedLoginAttempts` incremented atomically with `ADD`. On `>= 5`, set `lockedUntil = now + 15min`.
- Counter resets on successful login.
- Lockout is per-user, not per-IP (account-level protection at API Gateway is the throttle).

### 8.2 `property`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/properties` | owner | Paginated, `?status=`, `?q=` (client-side filter on `label`) |
| POST | `/properties` | owner | Idempotent via `Idempotency-Key` |
| GET | `/properties/:id` | owner | Includes `activeLeaseId` (in-process call to `leaseService`) |
| PATCH | `/properties/:id` | owner | Requires `If-Match: <version>` |
| DELETE | `/properties/:id` | owner | **Rejected with `409 PROPERTY_HAS_ACTIVE_LEASE`** if an active lease exists. Otherwise soft delete. |
| POST | `/properties/:id/photos/presign` | owner | `{ contentType, sizeBytes }` → `{ uploadUrl, s3Key, expiresIn }` |
| POST | `/properties/:id/photos` | owner | `{ s3Key }` — verifies S3 object exists + `Content-Length <= 10 MB`, then records key |

**Upload rules:** `contentType ∈ {image/jpeg, image/png, image/webp}`, `sizeBytes <= 10 MB`. Presigned PUT URL valid 5 minutes, `Content-Type` pinned in the signature.

### 8.3 `tenant`

| Method | Path | Role |
|---|---|---|
| GET | `/tenants` | owner — sorted directory via GSI1 |
| POST | `/tenants` | owner |
| GET | `/tenants/:id` | owner — includes active lease summary |
| PATCH | `/tenants/:id` | owner |
| DELETE | `/tenants/:id` | owner — `409 TENANT_HAS_ACTIVE_LEASE` guard |
| PUT | `/tenants/:id/id-document` | owner — `{ type, number, issuedAt?, expiresAt?, fileKey? }`; `number` is encrypted before write |

**PII handling:** `idDocument.number` MUST be encrypted with AES-256-GCM using `field-encryption-key` from SSM before it reaches DynamoDB. Stored as `v1:<iv>:<ciphertext>:<tag>` (base64). Decryption happens **only** in `tenantService.getDecryptedIdDocument()`, which is called by exactly one route (owner-only) and never by list endpoints. List responses return `idDocumentType` and `idDocumentLast4` only.

### 8.4 `lease`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/leases` | owner | `?status=`, `?propertyId=`, `?tenantId=` |
| POST | `/leases` | owner | Transactional: creates lease + links + generates payment schedule |
| GET | `/leases/:id` | owner | Includes property, tenants, next payment |
| PATCH | `/leases/:id` | owner | `If-Match` required. Rent changes only allowed from `startDate` forward. |
| POST | `/leases/:id/terminate` | owner | `{ terminatedAt, reason }`; cancels future `due` payments |
| POST | `/leases/:id/renew` | owner | Creates a successor lease; original → `expired` |
| GET | `/leases/:id/schedule` | owner | Payment schedule derived from lease terms |
| POST | `/leases/:id/documents/generate` | owner | `{ documentType }` → `202 { jobId }` |
| POST | `/leases/:id/etat-des-lieux` | owner | `{ kind: 'entree'\|'sortie', items[] }` → `202 { jobId }` |

**Payment schedule generation** (on lease create):

```
For each period from startDate to endDate, step = billingFrequency:
  dueDate = paymentDayOfMonth of period start month (clamped to 28)
  write Payment { status: 'due', amountDue: rentAmount + chargesAmount }
```

Uses `BatchWriteItem` in chunks of 25. Schedule generation is inside the same request (bounded: max 120 months). If `> 120` periods, return `400 LEASE_DURATION_TOO_LONG`.

**Cross-module call (in-process):**

```ts
// modules/lease/service.ts
import { propertyService } from '../property';
import { tenantService } from '../tenant';

async function createLease(ctx: Ctx, input: CreateLeaseInput): Promise<Lease> {
  const property = await propertyService.getById(ctx, input.propertyId);   // in-process

  if (!property) {
    throw new NotFoundError('PROPERTY_NOT_FOUND');
  }

  if (property.status === 'archived') {
    throw new ConflictError('PROPERTY_ARCHIVED');
  }

  const tenants = await tenantService.getManyById(ctx, input.tenantIds);    // in-process

  // ... validation, transaction, schedule generation
}
```

### 8.5 `payment`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/payments` | owner | `?status=`, `?leaseId=`, `?from=`, `?to=` |
| GET | `/payments/overdue` | owner | GSI2 `STATUS#late` + `STATUS#partial` past due |
| POST | `/payments` | owner | Manual payment record. Idempotent. |
| GET | `/payments/:id` | owner | |
| PATCH | `/payments/:id` | owner | `If-Match` required |
| POST | `/payments/:id/mark-paid` | owner | `{ paidAt, paymentMethod, amountPaid }` |
| POST | `/payments/:id/quittance` | owner | `202 { jobId }` — enqueues `PDF_GENERATE` |
| POST | `/payments/:id/cancel` | owner | `409 PAYMENT_ALREADY_PAID` guard |

**Quittance numbering — the only place it happens:**

```ts
// modules/payment/repository.ts
async nextQuittanceNumber(): Promise<number> {
  const out = await this.client.send(new UpdateItemCommand({
    TableName: this.tableName,
    Key: { PK: pk.account(this.accountId), SK: sk.counterQuittance() },
    UpdateExpression: 'ADD #n :one SET #u = :now',
    ExpressionAttributeNames: { '#n': 'nextNumber', '#u': 'updatedAt' },
    ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    ReturnValues: 'UPDATED_NEW',
  }));

  return out.Attributes!.nextNumber as number;
}
```

The counter is incremented **only when the quittance PDF job is enqueued** (not on preview), so numbers are gap-free in the legal sequence. If the job later fails permanently, the number is recorded on the failed `Job` item for manual reconciliation — **do not** reuse numbers.

### 8.6 `document`

| Method | Path | Role |
|---|---|---|
| GET | `/documents` | owner — `?linkedEntityType=&linkedEntityId=&documentType=` |
| GET | `/documents/:id` | owner — metadata only |
| GET | `/documents/:id/download-url` | owner — `200 { url, expiresIn: 300 }` |
| POST | `/documents/presign` | owner — `{ documentType, linkedEntityType, linkedEntityId, contentType, sizeBytes }` |
| POST | `/documents` | owner — confirm upload, create `DOC#` item |
| DELETE | `/documents/:id` | owner — soft delete; S3 object retained (10-year retention) |

**Download URL rules:** presigned `GetObject` URL, 5-minute expiry, `ResponseContentDisposition: attachment; filename="<safe-name>"`. Filenames are sanitized (`[^A-Za-z0-9._-]` → `_`) to prevent header injection.

### 8.7 `maintenance`

| Method | Path | Role |
|---|---|---|
| GET | `/maintenance/tickets` | owner — `?status=&propertyId=` |
| POST | `/maintenance/tickets` | owner |
| GET | `/maintenance/tickets/:id` | owner |
| PATCH | `/maintenance/tickets/:id` | owner — status/cost updates |
| POST | `/maintenance/tickets/:id/attachments` | owner — presigned flow, same rules as §8.2 |

### 8.8 `dashboard`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/dashboard` | owner | Single call returning everything the SPA dashboard needs |

Response is assembled from **four parallel reads**, no scans:

```ts
const [current, previous, upcoming, tickets] = await Promise.all([
  summaryRepo.get(currentMonth),
  summaryRepo.get(previousMonth),
  paymentRepo.listDueNext30Days(10),
  maintenanceRepo.countOpen(),
]);
```

Target: p95 `<= 250 ms` warm. On cold start, summary items are the only mandatory reads; `upcoming` and `tickets` degrade to empty arrays on timeout rather than failing the request (graceful degradation for the `<= 2.5 s on 4G` NFR).

### 8.9 `report`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/reports/summary` | owner | `?from=&to=` — reads pre-aggregated `SUMMARY#` items, max 24 months per call |
| POST | `/reports/export` | owner | `{ format: 'xlsx'\|'pdf', reportType, from, to, filters? }` → `202 { jobId }` |
| GET | `/reports/tax` | owner | Annual income statement for Moroccan tax filing |

**Reporting MUST NOT scan the base table.** The service reads `SUMMARY#<yyyy-mm>` items only. If a report needs finer granularity than monthly, it pages `Query(GSI1, LEASE#<id>)` per lease — still bounded by lease count.

### 8.10 `job`

| Method | Path | Role |
|---|---|---|
| GET | `/jobs/:jobId` | owner — poll async work status |
| GET | `/jobs` | owner — `?status=&type=` (last 30 days) |

`GET /jobs/:jobId` response:

```json
{
  "jobId": "01J...",
  "jobType": "PDF_GENERATE",
  "status": "succeeded",
  "resultDocumentId": "01J...",
  "downloadUrl": "https://...",     // presigned, present only when succeeded
  "error": null,
  "createdAt": "...",
  "finishedAt": "..."
}
```

The `downloadUrl` is generated on read with a 15-minute expiry — never stored.

### 8.11 `admin`

All routes require `role === 'super_admin'` **and** `impersonating !== true`.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/accounts` | Paginated list of accounts (cross-account — the only such read) |
| GET | `/admin/accounts/:id` | Account detail (metadata only) |
| POST | `/admin/impersonate/:accountId` | Returns a 30-minute read-only token with `imp: true`, `aud: 'rental-app-api'`, `sid` bound to the admin session |
| GET | `/admin/audit` | `?accountId=&from=&to=&action=` — reads `AUDIT#` partition |
| GET | `/admin/health` | Aggregated health: DLQ depths, Lambda error rates (via CloudWatch `GetMetricStatistics`), table status |
| POST | `/admin/accounts/:id/disable` | Sets `status: 'disabled'`; all sessions revoked |

**Impersonation token issuance MUST write an audit entry synchronously** before returning, because a failure to audit is a compliance failure.

---

## 9. Error Handling

### 9.1 Taxonomy

```ts
// src/shared/errors/app-error.ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
    readonly expose = true,
  ) {
    super(message);
  }
}

export class ValidationError extends AppError {
  constructor(d: unknown) {
    super('VALIDATION_ERROR', 400, 'Request validation failed', d);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(m = 'Unauthenticated') {
    super('UNAUTHENTICATED', 401, m);
  }
}

export class ForbiddenError extends AppError {
  constructor(m = 'Forbidden') {
    super('FORBIDDEN', 403, m);
  }
}

export class NotFoundError extends AppError {
  constructor(code = 'NOT_FOUND') {
    super(code, 404, 'Resource not found');
  }
}

export class ConflictError extends AppError {
  constructor(code = 'CONFLICT', m = 'Conflict') {
    super(code, 409, m);
  }
}

export class PreconditionError extends AppError {
  constructor(code = 'PRECONDITION_FAILED', m = 'Precondition failed') {
    super(code, 412, m);
  }
}

export class RateLimitError extends AppError {
  constructor(m = 'Too many requests', retryAfter = 60) {
    super('RATE_LIMITED', 429, m, { retryAfter });
  }
}

export class InternalError extends AppError {
  constructor(m = 'Internal error') {
    super('INTERNAL', 500, m, undefined, false);
  }
}
```

### 9.2 Error codes (stable API contract)

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod failure; `details` is a field-error array |
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired access token |
| `INVALID_CREDENTIALS` | 401 | Login failure |
| `INVALID_REFRESH` | 401 | Refresh token unknown |
| `SESSION_REVOKED` | 401 | Rotation reuse detected or session superseded |
| `INVALID_OTP` | 401 | Wrong MFA code |
| `FORBIDDEN` | 403 | Role/ownership failure |
| `ACCOUNT_DISABLED` | 403 | `account.status === 'disabled'` |
| `NOT_FOUND` | 404 | Generic |
| `PROPERTY_NOT_FOUND` | 404 | Entity-specific |
| `LEASE_NOT_FOUND` | 404 | |
| `PAYMENT_NOT_FOUND` | 404 | |
| `CONFLICT` | 409 | Generic |
| `EMAIL_TAKEN` | 409 | |
| `PROPERTY_HAS_ACTIVE_LEASE` | 409 | |
| `TENANT_HAS_ACTIVE_LEASE` | 409 | |
| `PAYMENT_ALREADY_PAID` | 409 | |
| `CONFLICT_VERSION_MISMATCH` | 409 | Optimistic lock failure |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different request body |
| `OTP_EXPIRED` | 410 | |
| `PRECONDITION_FAILED` | 412 | Missing `If-Match` |
| `ACCOUNT_LOCKED` | 423 | |
| `OTP_ATTEMPTS_EXCEEDED` | 429 | |
| `OTP_RATE_LIMITED` | 429 | |
| `RATE_LIMITED` | 429 | |
| `INTERNAL` | 500 | Never exposes message or stack |
| `SERVICE_UNAVAILABLE` | 503 | Upstream dependency down |

### 9.3 `onError` implementation

```ts
// src/shared/errors/on-error.ts
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  const logger = c.get('logger');

  if (err instanceof AppError && err.expose) {
    if (err.httpStatus >= 500) {
      logger.error({ err, code: err.code }, err.message);
    } else {
      logger.warn({ code: err.code }, err.message);
    }

    const headers: Record<string, string> = {};

    if (err instanceof RateLimitError) {
      headers['Retry-After'] = String((err.details as { retryAfter: number }).retryAfter);
    }

    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: err.details ?? undefined,
          requestId,
        },
      },
      err.httpStatus as ContentfulStatusCode,
      headers,
    );
  }

  // Unknown — log full, return opaque
  logger.error({ err, requestId }, 'Unhandled error');
  Sentry.captureException(err, { tags: { requestId } });

  return c.json(
    { error: { code: 'INTERNAL', message: 'Internal server error', requestId } },
    500,
  );
};
```

**Rule:** `AppError` messages ARE user-facing strings when `expose === true`. They MUST be written in a way that is safe to display and free of internal identifiers.

### 9.4 Zod validation

```ts
// modules/payment/routes.ts
const CreatePaymentSchema = z
  .object({
    leaseId: z.string().ulid(),
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    dueDate: z.string().date(),
    amountDue: z.number().int().positive().max(100_000_000),   // centimes
    notes: z.string().max(500).optional(),
  })
  .refine((v) => v.periodEnd > v.periodStart, {
    message: 'periodEnd must be after periodStart',
    path: ['periodEnd'],
  });

paymentRoutes.post(
  '/',
  zValidator('json', CreatePaymentSchema, (result) => {
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      );
    }
  }),
  handler,
);
```

**Money is always an integer number of centimes.** No floats anywhere in the money path. Formatting to `MAD` happens in the frontend only.

---

## 10. Idempotency

### 10.1 Synchronous endpoints

Routes declaring `idempotent: true` require an `Idempotency-Key` header (ULID or UUID, 16–128 chars).

Flow:

1. `PutItem(PK=ACCOUNT#<id>, SK=IDEMPOTENCY#<key>, ConditionExpression: attribute_not_exists(SK))`
   with `{ status: 'in_progress', requestHash, ttl: now + 24h }`.
2. If the condition fails, read the existing item:
   - `status === 'completed'` → return the stored `{ status, body }` verbatim with `Idempotent-Replay: true`.
   - `status === 'in_progress'` and `createdAt` older than 30 s → allow retry (take over).
   - `status === 'in_progress'` and recent → `409 CONFLICT` with `Retry-After: 2`.
3. On success, `UpdateItem` the record to `{ status: 'completed', responseStatus, responseBody }`.
4. `requestHash = sha256(method + path + JSON.stringify(body))`. A mismatch on replay returns `409 IDEMPOTENCY_KEY_REUSED`.

**Idempotent routes:** `POST /properties`, `POST /tenants`, `POST /leases`, `POST /payments`, `POST /documents`, `POST /maintenance/tickets`, `POST /reports/export`, and all `*/documents/generate` endpoints.

### 10.2 Asynchronous workers

Every SQS message carries a `jobId`. Workers start with:

```ts
const job = await jobRepo.get(jobId);

if (!job) {
  throw new NonRetryableError('JOB_NOT_FOUND');
}

if (job.status === 'succeeded') {
  return;             // already done — ack
}

if (job.status === 'processing' && !isStale(job)) {
  return;             // another invocation owns it
}

await jobRepo.markProcessing(jobId, { expectedStatus: 'queued' });   // conditional
```

`markProcessing` uses `ConditionExpression: #status = :queued` so duplicate deliveries cannot double-render. On success, `markSucceeded` uses `ConditionExpression: #status = :processing`.

The shared worker job repository also permits reclaiming a `processing` job only when its `startedAt` is older than the worker-specific stale threshold. The current thresholds are 120 s (PDF), 240 s (report), and 60 s (notification), each greater than the corresponding Lambda timeout. Claims increment `attempts` atomically and clear prior error state. Retryable failures set the job back to `queued` with a non-sensitive error summary before returning the SQS record as failed. Non-retryable failures set `failed` and are acknowledged. On the configured third receive, a retryable failure is recorded as terminal `failed` while still returning the SQS record as failed so SQS can move it to the configured DLQ.

### 10.3 Stream aggregator

Dedupe via `PROCESSED#<eventId>` written transactionally with the summary update — see [Section 11.5](#115-stream-aggregator).

---

## 11. Async Workers

### 11.1 Queue contracts (Terraform)

| Queue | Visibility timeout | Retention | DLQ | Max receives |
|---|---|---|---|---|
| `pdf-queue` | 360 s | 4 days | `pdf-dlq` | 3 |
| `report-queue` | 720 s | 4 days | `report-dlq` | 3 |
| `notification-queue` | 180 s | 4 days | `notification-dlq` | 3 |

All queues: `SqsManagedSseEnabled: true`, `MessageRetentionPeriod` as above. Lambda event source mappings use `ReportBatchItemFailures`, `BatchSize: 10`, `MaximumBatchingWindowInSeconds: 5`, `FunctionResponseTypes: ['ReportBatchItemFailures']`. The visibility timeout is at least six times the consumer Lambda timeout: PDF 6 × 60 s, report 6 × 120 s, notification 6 × 30 s.

**Visibility timeout MUST be `>= 6 × Lambda timeout`.** This reduces premature retries but does not provide exactly-once delivery; each worker's handler MUST be idempotent. See correction C-7.

### 11.2 `pdf-worker`

**Handler**

```ts
// src/lambdas/pdf-worker.ts
import { createConsumer } from '../shared/sqs/consumer';

export const handler = createConsumer<PdfJobPayload>({
  jobType: 'PDF_GENERATE',
  concurrency: 4,
  handle: async (payload, ctx) => {
    switch (payload.documentType) {
      case 'QUITTANCE':
        return renderQuittance(ctx, payload);
      case 'LEASE':
        return renderLease(ctx, payload);
      case 'FICHE_POLICE':
        return renderFichePolice(ctx, payload);
      case 'ETAT_DES_LIEUX':
        return renderEtatDesLieux(ctx, payload);
      default:
        throw new NonRetryableError('UNKNOWN_DOCUMENT_TYPE');
    }
  },
});
```

**Payload**

```ts
type PdfJobPayload =
  | { jobId: string; accountId: string; documentType: 'QUITTANCE'; paymentId: string }
  | { jobId: string; accountId: string; documentType: 'LEASE'; leaseId: string }
  | { jobId: string; accountId: string; documentType: 'FICHE_POLICE'; leaseId: string }
  | { jobId: string; accountId: string; documentType: 'ETAT_DES_LIEUX'; leaseId: string; kind: 'entree' | 'sortie' };
```

**Rendering pipeline**

```
1. Load domain data (repositories scoped to payload.accountId)
2. Render Handlebars HTML template (locale from Account.locale)
3. Launch Chromium (module-scoped, reused across invocations)
4. page.setContent(html, { waitUntil: 'networkidle0' })
5. page.pdf({ format: 'A4', printBackground: true, margin: {...} })
6. PutObject to DOCUMENTS_BUCKET at documents/<accountId>/<yyyy>/<documentId>.pdf
   with ServerSideEncryption: 'AES256', ContentType: 'application/pdf',
   ChecksumAlgorithm: 'SHA256', Metadata: { accountId, documentType, generatedBy: 'pdf-worker' }
7. TransactWriteItems: JOB#<id> → succeeded, DOC#<id> → created
8. Enqueue NOTIFICATION_QUEUE message { jobId, kind: 'DOCUMENT_READY' }
```

**Chromium reuse**

```ts
// src/shared/pdf/browser.ts
let browserPromise: Promise<Browser> | null = null;

export const getBrowser = async () => {
  browserPromise ??= puppeteer.launch({
    args: [...chromium.args, '--font-render-hinting=none', '--disable-dev-shm-usage'],
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  return browserPromise;
};
```

The browser is **never closed** between invocations; Lambda freezes the process and reuses it. On `SIGTERM` (Lambda shutdown) close it:

```ts
process.on('SIGTERM', async () => {
  await (await browserPromise)?.close();
});
```

**Arabic support (Architecture risk #4):** fonts (`Noto Naskh Arabic`, `Noto Sans`, `Inter`) MUST be bundled as files in the deployment package and inlined as base64 `@font-face` in the template CSS. Do **not** rely on `fontconfig` in the Lambda image. A CI test renders a fixture containing Arabic text and asserts the extracted PDF text contains the expected shaped glyphs — this test is the mitigation for risk #4 and MUST exist before the first Arabic template ships.

**Memory/timeout:** 1024 MB, 60 s. A quittance render is `~1.5 s` warm. Cold start (Chromium extraction) is `~4–6 s` — hence the 60 s ceiling.

### 11.3 `report-worker`

**Payload**

```ts
type ReportJobPayload = {
  jobId: string;
  accountId: string;
  format: 'xlsx' | 'pdf';
  reportType: 'INCOME_STATEMENT' | 'PAYMENT_REGISTER' | 'LEASE_REGISTER' | 'TAX_ANNUAL';
  from: string;   // YYYY-MM-DD
  to: string;
  filters?: { propertyId?: string; leaseId?: string; status?: string[] };
};
```

**Pipeline**

```
1. Parse date range → list of SUMMARY# items (Query on base table, begins_with SK='SUMMARY#')
2. For row-level reports, page Query(GSI1, LEASE#<id>) per lease — never Scan
3. Build workbook with exceljs (streaming WorkbookWriter) or HTML→PDF via shared browser
4. Stream to S3 via multipart upload (do NOT buffer in memory beyond 50 MB)
5. TransactWriteItems: JOB#<id> → succeeded, DOC#<id> → created
6. Enqueue NOTIFICATION_QUEUE { jobId, kind: 'REPORT_READY' }
```

**Guard:** if the estimated row count exceeds **50,000**, fail with `NonRetryableError('REPORT_TOO_LARGE')` and record a `Job.error` guiding the user to narrow the range. This prevents 120 s timeouts that would otherwise burn retries.

**Memory/timeout:** 1024 MB, 120 s.

### 11.4 `notification-worker`

**Payload**

```ts
type NotificationJobPayload =
  | { jobId: string; accountId: string; kind: 'DOCUMENT_READY'; documentId: string; channel: 'email' | 'whatsapp' }
  | { jobId: string; accountId: string; kind: 'RENT_REMINDER'; paymentId: string; channel: 'email' | 'whatsapp' }
  | { jobId: string; accountId: string; kind: 'RENT_OVERDUE'; paymentId: string; channel: 'email' | 'whatsapp' }
  | { jobId: string; accountId: string; kind: 'LEASE_EXPIRING'; leaseId: string; daysRemaining: number; channel: 'email' | 'whatsapp' }
  | { jobId: string; accountId: string; kind: 'MFA_OTP'; userId: string; code: string; channel: 'email' }
  | { jobId: string; accountId: string; kind: 'PASSWORD_RESET'; userId: string; code: string; channel: 'email' };
```

**SES adapter**

- `SendEmailCommand` with a pre-provisioned template (`TemplateName: rental-app-<kind>-<locale>`).
- `ConfigurationSetName: config.SES_CONFIG_SET` for bounce/complaint tracking.
- From: `Rental App <no-reply@rental-app.ma>`.
- **OTP emails bypass templates** and use a plain `Content.Simple` — templates add latency and OTP is time-critical.

**Twilio adapter (cost-controlled)**

```ts
// src/shared/notify/whatsapp.ts
export async function sendWhatsApp(input: SendInput): Promise<void> {
  const month = input.sentAt.slice(0, 7);
  const counter = await counterRepo.incrementWhatsapp(month);   // ADD 1, ReturnValues UPDATED_NEW

  if (counter > config.TWILIO_MONTHLY_CAP) {
    logger.warn({ month, counter }, 'Twilio hard cap reached — falling back to email');
    await sesAdapter.send({ ...input, channel: 'email', template: 'fallback' });
    metrics.emit('WhatsappCapFallback', 1);

    return;
  }

  const res = await twilioClient.messages.create({
    from: `whatsapp:${secrets.twilioWhatsappFrom}`,
    to: `whatsapp:${input.toE164}`,
    contentSid: input.templateSid,
    contentVariables: JSON.stringify(input.variables),
  });

  if (res.status === 'failed' || res.status === 'undelivered') {
    throw new RetryableError(`TWILIO_${res.status.toUpperCase()}`);
  }
}
```

**Retry classification:**

| Error | Class | Behaviour |
|---|---|---|
| Twilio 429 / 5xx | Retryable | SQS redelivery with backoff |
| Twilio 4xx (bad number) | Non-retryable | Ack, mark `Job.failed`, log |
| SES `Throttling` | Retryable | |
| SES `MessageRejected` (bad address) | Non-retryable | Ack, mark `Job.failed` |
| Cap reached | N/A | Fall back to email, ack |

**Idempotency:** notification jobs are deduplicated by the `Job` status guard (§10.2). Additionally, `RENT_REMINDER` and `RENT_OVERDUE` carry a deterministic `dedupeKey = <kind>:<paymentId>:<yyyy-mm>`; the worker writes `IDEMPOTENCY#<dedupeKey>` conditionally before sending.

**Memory/timeout:** 512 MB, 30 s.

### 11.5 `stream-aggregator`

**Event source:** DynamoDB Streams on `rental-app-main`, `NEW_AND_OLD_IMAGES`, `BatchSize: 100`, `BisectBatchOnFunctionError: true`, `MaximumRetryAttempts: 3`, `DestinationConfig.OnFailure → stream-dlq`, `ParallelizationFactor: 1`.

> `ParallelizationFactor: 1` is deliberate: aggregation updates target the same `SUMMARY#<yyyy-mm>` item per account, and parallel shard processing would create hot-partition contention for no throughput benefit at this scale.

**Handler**

```ts
export const handler = async (event: DynamoDBStreamEvent): Promise<BatchItemFailuresResponse> => {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      logger.error({ err, eventID: record.eventID }, 'Aggregation failed');
      failures.push({ itemIdentifier: record.eventID });
    }
  }

  return { batchItemFailures: failures };
};
```

**Deduplication + aggregation (single transaction)**

```ts
async function applyDelta(accountId: string, month: string, delta: SummaryDelta, eventId: string) {
  await client.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            PK: pk.account(accountId),
            SK: sk.processed(eventId),
            entityType: 'ProcessedEvent',
            accountId,
            eventId,
            ttl: Math.floor(Date.now() / 1000) + 86_400,
          },
          ConditionExpression: 'attribute_not_exists(SK)',
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { PK: pk.account(accountId), SK: sk.summary(month) },
          UpdateExpression: [
            'ADD totalIncome :inc, totalExpenses :dec, latePayments :late, paidPayments :paid',
            'SET updatedAt = :now, entityType = :et, accountId = :aid, PK = :pk, SK = :sk, #v = if_not_exists(#v, :zero)',
          ].join(' '),
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { /* ... */ },
        },
      },
    ],
  }));
}
```

A `TransactionCanceledException` whose cancellation reasons include `ConditionalCheckFailed` **on the `Put`** means the event was already processed → treat as success and return.

**Handled entity types:** `Payment` (INSERT/MODIFY status transitions, `amountPaid` deltas), `Lease` (INSERT/terminate → occupancy counters), `MaintenanceTicket` (status → `openTickets`), `Property` (INSERT/soft-delete → `totalProperties`).

**Unhandled types are skipped immediately** — do not throw, or every unrelated write becomes a retry.

**Month attribution:** a payment is attributed to `SUMMARY#<periodStart.slice(0, 7)>`. `MODIFY` events that change `periodStart` MUST reverse the old month's delta and apply to the new month — both in the same transaction (2 updates + 1 dedupe put = 3 items).

---

## 12. Security Implementation

### 12.1 Password hashing

```ts
// src/modules/auth/passwords.ts
import { Algorithm, hash, verify } from '@node-rs/argon2';

const ARGON_OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,   // 19 MiB — OWASP minimum
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export const hashPassword = (plain: string) => hash(plain, ARGON_OPTS);
export const verifyPassword = (plain: string, phc: string) => verify(phc, plain);
```

**Password policy (validated in Zod):** min 12 chars, at least one letter and one digit, not in the HaveIBeenPwned k-anonymity range (checked at registration and reset only, `Add-Padding: true`, 2 s timeout, **fail-open** — a HIBP outage must not block signup).

`passwordHash` MUST be excluded from every log, every error message, and every API response. `pino` redaction config:

```ts
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    '*.password',
    '*.passwordHash',
    '*.refreshToken',
    '*.refreshTokenHash',
    '*.code',
    '*.idDocument.number',
    '*.numberEnc',
  ],
  censor: '[REDACTED]',
}
```

### 12.2 Field-level encryption

```ts
// src/shared/crypto/field-crypto.ts
const KEY = Buffer.from(secrets.fieldEncryptionKey, 'base64');   // 32 bytes

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString('base64url')}:${ct.toString('base64url')}:${tag.toString('base64url')}`;
}

export function decryptField(stored: string): string { /* ... */ }
```

Applied to: `Tenant.idDocument.number`, `User.googleSub` (optional), any future passport/IBAN field.

**Key rotation:** version prefix `v1:` allows a future `v2:`. A rotation job reads → decrypts with old key → re-encrypts with new key. Until then, only one key exists and `decryptField` throws `INTERNAL` on an unknown version.

### 12.3 JWT verification

```ts
// src/shared/crypto/jwt.ts
import { createPublicKey, importPKCS8, jwtVerify, type KeyLike } from 'jose';

const ALG = 'RS256';
let publicKey: KeyLike | null = null;

async function getPublicKey(): Promise<KeyLike> {
  publicKey ??= await importPKCS8(secrets.jwtPublicKey, ALG).catch(() =>
    createPublicKey(secrets.jwtPublicKey),
  );

  return publicKey;
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, await getPublicKey(), {
    algorithms: [ALG],
    issuer: 'rental-app',
    audience: 'rental-app-api',
    clockTolerance: 5,
  });

  return AccessClaimsSchema.parse(payload);   // Zod-validate claims, never trust shape
}
```

**The `alg` header MUST be pinned.** Never accept `none` or HMAC algorithms.

### 12.4 Lambda authorizer

API Gateway HTTP API, `Authorization` header, simple response, **cache TTL 60 s**.

```ts
// src/lambdas/authorizer.ts
export const handler = async (event: APIGatewayRequestAuthorizerEventV2) => {
  const token = event.headers?.authorization?.replace(/^Bearer /i, '');

  if (!token) {
    return { isAuthorized: false };
  }

  try {
    const claims = await verifyAccessToken(token);

    return {
      isAuthorized: true,
      context: {
        userId: claims.sub,
        accountId: claims.account_id,
        role: claims.role,
        sid: claims.sid,
        impersonating: String(claims.imp === true),
      },
    };
  } catch {
    return { isAuthorized: false };
  }
};
```

> **Trade-off (documented):** the authorizer is a second Lambda invocation per uncached request. At ~100 users this costs `< $0.10/month`. The 60 s cache means a revoked super-admin session remains valid at the gateway for up to 60 s — the Hono `auth` middleware performs the authoritative session check on every request, so revocation is effective immediately at the application layer. This is defense in depth, not redundancy.

### 12.5 Rate limiting

| Layer | Limit | Config |
|---|---|---|
| API Gateway route-level | 100 req/s burst, 50 req/s steady | Terraform `aws_apigatewayv2_stage.default_route_settings` |
| `/auth/login` | 10 req/min per IP | In-app counter (see below) |
| `/auth/mfa/verify` | 5 attempts per challenge, 10 per hour per user | `OTP` item `attempts` + rate-limit item |
| `/auth/password/forgot` | 3 per hour per email | `OTP` rate-limit item |

In-app counters use a conditional `UpdateItem` with `ADD attempts :one` and a TTL, plus a `ConditionExpression: attempts < :max`. On failure → `RateLimitError`.

### 12.6 CORS

```ts
cors({
  origin: config.ALLOWED_ORIGINS,   // exact match list, never '*'
  credentials: true,                 // required for the refresh cookie
  maxAge: 600,
})
```

Wildcard origins are forbidden — `credentials: true` with `*` is rejected by browsers and would be a security defect anyway.

### 12.7 Security headers

Set on every response by a small middleware (CloudFront also sets some, but defense in depth):

```ts
c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
c.header('X-Content-Type-Options', 'nosniff');
c.header('X-Frame-Options', 'DENY');
c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
```

CSP is set on the **CloudFront/S3 static response**, not on API JSON.

---

## 13. Observability

### 13.1 Structured logging

```ts
// src/shared/logger/index.ts
import pino from 'pino';

export const baseLogger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'rental-api', stage: config.STAGE, version: BUILD_VERSION },
  redact: { paths: [...], censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});
```

**Mandatory fields on every log line emitted during a request:**

`requestId`, `traceId`, `route`, `method`, `status`, `durationMs`, `accountId` (when known), `userId` (when known), `module`, `coldStart`.

`coldStart` is computed once:

```ts
let isColdStart = true;
// in request-context middleware:
const coldStart = isColdStart;
isColdStart = false;
```

**Access log** is emitted once per request in the `logger` middleware's `finally` block, at `info` for `2xx/3xx`, `warn` for `4xx`, `error` for `5xx`.

**Never log:** request bodies, response bodies, `Authorization` headers, cookies, passwords, OTP codes, CIN/passport numbers, presigned URLs.

### 13.2 Metrics — EMF, not `PutMetricData`

```ts
// src/shared/metrics/index.ts
import { metricScope } from 'aws-embedded-metrics';

export const withMetrics = metricScope((metrics) => async (namespace, fn) => {
  metrics.setNamespace('RentalApp');
  metrics.setDimensions({ Stage: config.STAGE, Service: 'api' });

  return fn(metrics);
});
```

Custom metrics emitted:

| Metric | Unit | Where |
|---|---|---|
| `ApiRequestCount` | Count | every request |
| `ApiLatency` | Milliseconds | every request |
| `ApiErrorCount` | Count | 5xx only |
| `QuittanceGenerated` | Count | pdf-worker |
| `ReportExported` | Count | report-worker |
| `WhatsappSent` / `WhatsappCapFallback` | Count | notification-worker |
| `SummaryAggregated` | Count | stream-aggregator |
| `DlqMessageReceived` | Count | CloudWatch alarm on `ApproximateNumberOfMessagesVisible` |

**Rationale:** EMF metrics are emitted as structured log lines and cost nothing beyond CloudWatch Logs ingestion, versus `$0.30` per 1,000 `PutMetricData` calls. This is a direct response to the `$20/month` ceiling.

### 13.3 Alarms (Terraform)

| Alarm | Condition | Action |
|---|---|---|
| `api-5xx-rate` | `ApiErrorCount > 10` in 5 min | SNS → email |
| `api-p99-latency` | `p99 ApiLatency > 1500 ms` for 10 min | SNS |
| `pdf-dlq-depth` | `ApproximateNumberOfMessagesVisible >= 1` | SNS (immediate) |
| `report-dlq-depth` | `>= 1` | SNS |
| `notification-dlq-depth` | `>= 1` | SNS |
| `stream-dlq-depth` | `>= 1` | SNS |
| `dynamodb-throttles` | `ThrottledRequests > 0` | SNS |
| `lambda-concurrency` | `ConcurrentExecutions > 40` | SNS (headroom before the 50 reserved cap) |
| `budget-80` / `budget-100` | AWS Budgets | SNS |

### 13.4 Sentry

- `tracesSampleRate: 0.1`, `profilesSampleRate: 0`.
- `beforeSend` scrubs `request.data`, `request.cookies`, and any `*.password`/`*.token` fields.
- `Sentry.setUser({ id: userId })` only — never email.
- Alerts route to the same SNS topic as CloudWatch alarms for a single on-call inbox.

### 13.5 Correlation IDs

- `X-Request-Id` is honoured if supplied and well-formed (ULID/UUID), otherwise generated.
- It is echoed on every response.
- It is stored on `Job` items, `AuditLog` items, and DLQ messages so a user-visible failure can be traced end-to-end.

---

## 14. Scheduled Work

EventBridge Scheduler rules invoke `api-handler` directly (not through API Gateway) with a signed payload. The internal paths are blocked at the Hono layer unless the request carries a valid HMAC signature.

### 14.1 `mark-overdue-payments` (daily, 02:00 Africa/Casablanca)

```
Query(GSI2, GSI2PK=ACCOUNT#<id>#STATUS#due) + STATUS#partial for all accounts
For each payment where dueDate < today:
  UpdateItem: status = 'late', GSI2PK = ACCOUNT#<id>#STATUS#late
  (conditional on current status still being due/partial)
BatchWriteItem in chunks of 25.
```

Bounded by design: at 100 accounts × ~120 payments/year, this touches `< 3,000` items. The aggregator updates `SUMMARY#` counters via the resulting stream events.

**Guard:** the job processes at most **5,000** payments per run and logs `OverdueJobTruncated` if the cap is hit.

### 14.2 `generate-rent-reminders` (daily, 08:00)

Finds payments with `dueDate` in `T-3 days`, enqueues `RENT_REMINDER` notifications. Deterministic `dedupeKey` prevents duplicates on retry.

### 14.3 `generate-overdue-notices` (daily, 08:15)

Finds payments with `status = 'late'` and `daysLate ∈ {1, 7, 15, 30}`, enqueues `RENT_OVERDUE` notifications.

### 14.4 `lease-expiry-check` (daily, 08:30)

Finds active leases with `endDate` in `T-60/30/7 days`, enqueues `LEASE_EXPIRING` notifications.

### 14.5 `purge-expired-sessions` (weekly)

DynamoDB TTL handles OTPs and idempotency records. Sessions have no TTL (explicit revoke), so a weekly job removes `SESSION#` items with `expiresAt < now - 30 days`.

### 14.6 Internal invocation guard

```ts
app.use('/internal/*', async (c, next) => {
  const sig = c.req.header('X-Internal-Signature');
  const ts = c.req.header('X-Internal-Timestamp');

  if (!sig || !ts) {
    throw new NotFoundError();               // 404, not 401 — don't advertise
  }

  if (Math.abs(Date.now() - Number(ts)) > 300_000) {
    throw new UnauthenticatedError('Stale');
  }

  const expected = hmacSha256(secrets.internalJobKey, `${ts}.${c.req.path}`);

  if (!timingSafeEqual(sig, expected)) {
    throw new UnauthenticatedError();
  }

  await next();
});
```

**Direct `Invoke` is preferred** — it avoids API Gateway entirely and keeps the internal path off the public surface.

---

## 15. Testing Strategy

### 15.1 Test pyramid

| Layer | Tool | Coverage target | What it proves |
|---|---|---|---|
| Unit — services | Vitest | **90%** lines in `modules/*/service.ts` | Business rules, money math, state transitions |
| Unit — repositories | Vitest + `dynamodb-local` | **85%** lines | Key construction, GSI usage, condition expressions |
| Unit — validators | Vitest | **100%** of schemas have a happy + unhappy case | Input contract |
| Integration — routes | Vitest + `app.request()` | Every route | Status codes, error codes, auth/role enforcement |
| Integration — workers | Vitest + localstack SQS | Every worker | Idempotency, partial batch failure, DLQ |
| Contract — OpenAPI | `@hono/zod-openapi` + `openapi-diff` in CI | — | No breaking changes without a version bump |
| Security | `pnpm audit` + OWASP ZAP baseline scan | — | NFR §7 trade-off mitigation |
| Load | k6 (smoke profile) | — | p95/p99 NFR targets |

### 15.2 Mandatory test cases (must exist before merge)

**Auth**
- Login with correct/incorrect password.
- 5 failed attempts → `ACCOUNT_LOCKED`; 6th attempt with correct password still locked.
- Refresh token rotation: use token → rotate → **reuse old token → `SESSION_REVOKED` and session destroyed**.
- Super admin second login invalidates the first session's access token on the next request.
- OTP expiry after 5 minutes; OTP max attempts.

**Account isolation** (the highest-value test in the suite)

```
Given: account A has a late payment, account B has a late payment
When:  A queries GET /payments/overdue
Then:  the response contains exactly A's payment, and zero of B's
```

This test MUST be run against **every** GSI-backed endpoint, parameterized by route.

**Money**
- `amountPaid` partial → `partial`; equal → `paid`; over → rejected `400`.
- Quittance numbering under concurrency: 50 parallel `recordPayment` calls produce 50 distinct sequential numbers with no gaps.

**Lease lifecycle**
- Create → schedule length matches duration × frequency.
- Terminate → future `due` payments become `cancelled`, past `paid` untouched.
- Cannot delete a property with an active lease.

**Workers**
- Duplicate SQS delivery of the same `jobId` produces exactly one PDF and one S3 object.
- A job that throws `NonRetryableError` is marked `failed` and the message is acked (not retried).
- A job that throws `RetryableError` is returned in `batchItemFailures` and retried.

**Aggregator**
- Replaying the same stream event twice produces the same `SUMMARY#` values (idempotency).
- A payment moving from `due` → `paid` increments `paidPayments` and decrements nothing else.
- A `MODIFY` that changes `periodStart` moves the delta between months.

### 15.3 Test infrastructure

```yaml
# docker-compose.test.yml
services:
  dynamodb-local:
    image: amazon/dynamodb-local:latest
    command: -jar DynamoDBLocal.jar -sharedDb -inMemory
    ports: ['8000:8000']
  localstack:
    image: localstack/localstack:latest
    environment:
      SERVICES: s3,sqs,ses,ssm
    ports: ['4566:4566']
```

`test/setup/dynamodb.ts` creates the table + GSIs before the suite and truncates between tests via `BatchWriteItem` deletes on a `Query` of the account partition.

**No test may call real AWS.** A pre-test assertion fails the suite if `AWS_ACCESS_KEY_ID` resolves to a non-local endpoint.

### 15.4 Coverage gates

`vitest.config.ts`:

```ts
coverage: {
  provider: 'v8',
  thresholds: {
    lines: 80, functions: 80, branches: 75, statements: 80,
    'src/modules/**/service.ts': { lines: 90, branches: 85 },
    'src/shared/db/**': { lines: 85 },
  },
  exclude: ['src/lambdas/**', 'src/generated/**', '**/*.d.ts'],
}
```

`src/lambdas/**` is excluded from unit coverage because those files are thin adapters; they are covered by integration tests against the handler directly.

---

## 16. Local Development

### 16.1 Scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/local/server.ts",
    "typecheck": "tsgo --noEmit",
    "lint": "eslint . --max-warnings 0",
    "lint:fix": "eslint . --fix",
    "dep:check": "depcruise src --config .dependency-cruiser.cjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "build:api": "node esbuild.config.ts api-handler",
    "build:pdf": "node esbuild.config.ts pdf-worker",
    "build:report": "node esbuild.config.ts report-worker",
    "build:notify": "node esbuild.config.ts notification-worker",
    "build:stream": "node esbuild.config.ts stream-aggregator",
    "build:authorizer": "node esbuild.config.ts authorizer",
    "build": "pnpm build:api && pnpm build:pdf && pnpm build:report && pnpm build:notify && pnpm build:stream && pnpm build:authorizer && tsx scripts/verify-bundle-size.ts",
    "seed": "tsx scripts/seed-local.ts",
    "test:load": "k6 run test/load/smoke.js"
  }
}
```

### 16.2 Local server

```ts
// src/local/server.ts
import { serve } from '@hono/node-server';

import { app } from '../app';

// Point SDK clients at localstack/dynamodb-local via env:
//   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000
//   AWS_ENDPOINT_URL_SQS=http://localhost:4566
//   AWS_ENDPOINT_URL_S3=http://localhost:4566
serve({ fetch: app.fetch, port: 3000 }, (info) =>
  console.log(`API on http://localhost:${info.port}`));
```

AWS SDK v3 respects `AWS_ENDPOINT_URL_<SERVICE>` natively — **no client code changes needed between local and Lambda**. This is a hard requirement: any conditional endpoint logic in a client factory is a defect.

### 16.3 Seeding

`scripts/seed-local.ts` creates:

- 1 account, 1 owner user (`owner@test.ma` / `TestPassword123`), 1 super admin.
- 3 properties, 3 tenants, 3 active leases, 36 payments spanning 12 months with mixed statuses.
- 12 `SUMMARY#` items.
- 1 open maintenance ticket.

Idempotent: running it twice does not duplicate data (it deletes the account partition first).

---

## 17. Build & Deployment

### 17.1 Artifacts

| Artifact | Source | Size budget |
|---|---|---|
| `api-handler.zip` | `dist/api-handler.mjs` + externals + templates | `<= 90 MB` unzipped |
| `authorizer.zip` | `dist/authorizer.mjs` | `<= 5 MB` |
| `pdf-worker.zip` | `dist/pdf-worker.mjs` + Chromium + fonts | `<= 220 MB` unzipped |
| `report-worker.zip` | `dist/report-worker.mjs` + Chromium + externals | `<= 100 MB` |
| `notification-worker.zip` | `dist/notification-worker.mjs` | `<= 30 MB` |
| `stream-aggregator.zip` | `dist/stream-aggregator.mjs` | `<= 5 MB` |

`scripts/verify-bundle-size.ts` fails the build on breach. Chromium is packaged only in `pdf-worker` and `report-worker`, which both render PDFs; it is excluded from `api-handler` to avoid breaching its limit and adding cold-start cost to API requests.

### 17.2 Lambda configuration (Terraform contract)

| Function | Runtime | Memory | Timeout | Reserved concurrency | Ephemeral storage |
|---|---|---|---|---|---|
| `api-handler` | `nodejs26.x` | 1024 | 29 s | 50 | 512 MB |
| `authorizer` | `nodejs26.x` | 256 | 5 s | 20 | 512 MB |
| `pdf-worker` | `nodejs26.x` | 1024 | 60 s | 10 | **2048 MB** |
| `report-worker` | `nodejs26.x` | 1024 | 120 s | 5 | 1024 MB |
| `notification-worker` | `nodejs26.x` | 512 | 30 s | 10 | 512 MB |
| `stream-aggregator` | `nodejs26.x` | 512 | 30 s | 5 | 512 MB |

All functions use the single runtime selected under C-6: `nodejs26.x` when generally available in `eu-west-1`, otherwise the newest generally available Node.js LTS runtime supported there, recorded in an ADR. Terraform and CI MUST use the same pinned value.

`pdf-worker` needs 2048 MB ephemeral storage because `@sparticuz/chromium` extracts a ~180 MB binary to `/tmp`.

**Reserved concurrency** caps are a cost control (Architecture §8.2) and a blast-radius control. Note that reserving concurrency on `api-handler` also caps its own scaling — 50 concurrent executions is far above the `<= 100 users` target given sub-second request durations.

### 17.3 CI/CD

```yaml
version: 2.1

jobs:
  verify:
    docker:
      - image: cimg/node:22.14.0
    steps:
      - checkout
      - run:
          name: Activate pinned pnpm
          command: |
            corepack enable
            corepack prepare pnpm@12.14.0 --activate
            pnpm config set store-dir ~/.pnpm-store
      - restore_cache:
          keys:
            - pnpm-v1-{{ checksum "pnpm-lock.yaml" }}
            - pnpm-v1-
      - run:
          name: Install dependencies
          command: pnpm install --frozen-lockfile
      - save_cache:
          key: pnpm-v1-{{ checksum "pnpm-lock.yaml" }}
          paths:
            - ~/.pnpm-store
      - run:
          name: Typecheck
          command: pnpm typecheck
      - run:
          name: Lint
          command: pnpm lint
      - run:
          name: Unit tests
          command: pnpm test
      - run:
          name: Build Lambda artifacts
          command: pnpm build

workflows:
  backend:
    jobs:
      - verify
```

The workflow runs on pushes and pull requests through CircleCI project triggers. Keep its verification commands aligned with scripts that exist in `package.json`; add integration-service containers and scans when those test suites and commands have been implemented.

**Deployment order** (per Architecture §6.4): Terraform apply → Lambda deploy (all 6) → S3 sync → CloudFront invalidation → smoke tests.

**Smoke tests** (`test/smoke/`): hit `GET /health`, register → login → create property → create lease → list payments against a dedicated smoke account; assert every status code; delete nothing (the smoke account is disposable and reset nightly).

### 17.4 Rollback

- Lambda versions + aliases: `prod` alias points at a published version. Rollback = repoint the alias, **no redeploy**.
- Terraform state is versioned in S3. Infrastructure rollback = `git revert` + apply, with the caveat that DynamoDB schema changes are forward-only.
- Frontend rollback = re-sync the previous S3 build (builds are retained 90 days).
- **RTO `<= 4 h` is satisfied by alias repointing (seconds) for code, and by Terraform redeploy (minutes) for infrastructure.**

---

## 18. Terraform Interface

The backend team owns application code; the platform team owns the Terraform modules. This is the contract between them.

### 18.1 Required outputs consumed by the backend build

| Output | Used by |
|---|---|
| `table_name` | Lambda env `TABLE_NAME` |
| `table_arn` | IAM policy |
| `documents_bucket_name` / `_arn` | Lambda env + IAM |
| `photos_bucket_name` / `_arn` | Lambda env + IAM |
| `pdf_queue_url` / `_arn` | Lambda env + IAM |
| `report_queue_url` / `_arn` | Lambda env + IAM |
| `notification_queue_url` / `_arn` | Lambda env + IAM |
| `ses_from_address` | Lambda env |
| `ssm_param_prefix` | Lambda env |

### 18.2 IAM per function (least privilege)

| Function | DynamoDB | S3 | SQS | Other |
|---|---|---|---|---|
| `api-handler` | `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `BatchGetItem`, `BatchWriteItem`, `TransactWriteItems` on table + GSIs | `PutObject` (photos bucket), `GetObject` (documents bucket) | `SendMessage` on all three queues | `ssm:GetParameter*` on `${prefix}/*` |
| `authorizer` | `GetItem` on table (`SESSION#` only, via `dynamodb:LeadingKeys` condition) | — | — | `ssm:GetParameter` on `${prefix}/jwt/public-key` |
| `pdf-worker` | `GetItem`, `Query`, `UpdateItem`, `TransactWriteItems` | `PutObject`, `GetObject` | `SendMessage` (notification), `ReceiveMessage`/`DeleteMessage` (pdf) | `ssm:GetParameter*` |
| `report-worker` | `GetItem`, `Query` | `PutObject`, multipart | `SendMessage`, `ReceiveMessage`/`DeleteMessage` | `ssm:GetParameter*` |
| `notification-worker` | `GetItem`, `UpdateItem` | — | `ReceiveMessage`/`DeleteMessage` (notification) | `ses:SendEmail`, `ssm:GetParameter*` |
| `stream-aggregator` | `UpdateItem`, `PutItem`, `TransactWriteItems` | — | — | — |

`api-handler` MUST NOT have `Scan`. `stream-aggregator` MUST NOT have `Query`. These are enforced by omitting the actions, and covered by an IAM policy test in CI (`pnpm test:iam` parses the Terraform JSON and asserts the negative).

---

## 19. Engineering Standards

### 19.1 ESLint configuration

**Tooling.** ESLint 9 flat config, type-aware via `projectService`, with `@stylistic/eslint-plugin` owning formatting. **Prettier is not used.** Adding Prettier later would require `eslint-config-prettier` to disable the stylistic rules in §19.1.6, and would still leave `padding-line-between-statements` disabled because Prettier has no equivalent for it — which is the rule this section exists to protect.

**Dev dependencies:**

| Package | Version | Purpose |
|---|---|---|
| `eslint` | `^9` | Runner |
| `@eslint/js` | `^9` | `js.configs.recommended` |
| `typescript-eslint` | `^8` | Type-aware rules + `projectService` |
| `@stylistic/eslint-plugin` | `^3` | Formatting rules (the successor to the deprecated core stylistic rules) |
| `eslint-plugin-import` | `^2` | Order, cycles, extensions |
| `eslint-import-resolver-typescript` | `^4` | Resolves `@/*` paths and extensionless imports |

The config is organized into six labelled rule groups. The labels are part of the deliverable: a reviewer should be able to find the rule that rejected their code by reading the group headings.

```js
// eslint.config.js
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'src/generated/**', 'node_modules/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
    },

    rules: {
      /* ---------------------------------------------------------------
       * 1. Readability — vertical whitespace
       *
       * A blank line before every return makes the *result* of a function
       * visually distinct from the work that produced it. The same logic
       * applies to declarations, control-flow blocks, and exports.
       * ------------------------------------------------------------- */

      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any',    prev: 'import', next: 'import' },
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any',    prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try'] },
        { blankLine: 'always', prev: ['if', 'for', 'while', 'switch', 'try'], next: '*' },
        { blankLine: 'always', prev: '*', next: 'export' },
        { blankLine: 'always', prev: 'export', next: '*' },
        { blankLine: 'any',    prev: 'export', next: 'export' },
        { blankLine: 'always', prev: 'directive', next: '*' },
      ],

      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
      '@stylistic/newline-per-chained-call': ['error', { ignoreChainWithDepth: 3 }],
      '@stylistic/implicit-arrow-linebreak': ['error', 'beside'],
      '@stylistic/object-curly-newline': [
        'error',
        {
          ObjectExpression:  { multiline: true, consistent: true },
          ObjectPattern:     { multiline: true, consistent: true },
          ImportDeclaration: { multiline: true, consistent: true, minProperties: 6 },
          ExportDeclaration: { multiline: true, consistent: true, minProperties: 6 },
        },
      ],
      '@stylistic/object-property-newline': [
        'error',
        { allowAllPropertiesOnSameLine: true },
      ],
      '@stylistic/function-paren-newline': ['error', 'multiline-arguments'],
      '@stylistic/array-element-newline': ['error', 'consistent'],
      '@stylistic/max-len': [
        'error',
        {
          code: 110,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: false,
        },
      ],

      /* ---------------------------------------------------------------
       * 2. Readability — control flow and naming
       * ------------------------------------------------------------- */

      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-unneeded-ternary': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-param-reassign': ['error', { props: true }],
      'no-shadow': 'off',                                  // superseded below
      '@typescript-eslint/no-shadow': ['error', { ignoreTypeValueShadow: true }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],

      /* ---------------------------------------------------------------
       * 3. Maintainability — complexity budgets
       *
       * These are deliberately generous. If a function trips them, the
       * correct response is to extract, not to add an eslint-disable.
       * ------------------------------------------------------------- */

      complexity:             ['error', 12],
      'max-depth':            ['error', 3],
      'max-nested-callbacks': ['error', 3],
      'max-params':           ['error', 4],
      'max-lines-per-function': [
        'warn',
        { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-classes-per-file': ['error', 1],

      /* ---------------------------------------------------------------
       * 4. Correctness — types
       * ------------------------------------------------------------- */

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': [
        'error',
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      /* ---------------------------------------------------------------
       * 5. Imports — order, cycles, extensions
       * ------------------------------------------------------------- */

      // No `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` suffix on any
      // relative import or re-export. See §4.4 and §19.3.
      'import/extensions': [
        'error',
        'ignorePackages',
        { ts: 'never', tsx: 'never', js: 'never', mjs: 'never', cjs: 'never', jsx: 'never' },
      ],
      'import/no-cycle': ['error', { maxDepth: 10, ignoreExternal: true }],
      'import/no-default-export': 'error',
      'import/no-duplicates': ['error', { 'prefer-inline': true }],
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': ['error', { noUselessIndex: true }],
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          pathGroups: [{ pattern: '@/**', group: 'internal', position: 'before' }],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      /* ---------------------------------------------------------------
       * 6. Module boundaries (Architecture v2.0 §9.2)
       * ------------------------------------------------------------- */

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '*/modules/*/repository',
                '*/modules/*/validators',
                '*/modules/*/types',
                '*/modules/*/tokens',
                '*/modules/*/passwords',
              ],
              message: "Import only from a module's index.ts (public API).",
            },
            {
              group: ['**/modules/*/repository', '**/modules/*/validators'],
              message: 'Cross-module repository access is forbidden.',
            },
          ],
        },
      ],
    },
  },

  /* -----------------------------------------------------------------
   * Per-directory overrides
   * --------------------------------------------------------------- */

  // shared/ must not depend on modules/.
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/modules/**'], message: 'shared/ must not depend on modules/.' },
          ],
        },
      ],
    },
  },

  // Services are pure. No AWS SDK, no repository imports, no I/O.
  {
    files: ['src/modules/**/service.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', '@aws-sdk/**'],
              message: 'Services must not call the AWS SDK. Put I/O in repository.ts.',
            },
            {
              group: ['**/modules/*/repository'],
              message: 'Services receive repositories via the scoped repository factory.',
            },
          ],
        },
      ],
    },
  },

  // Lambda entry points need a default export. Nothing else does.
  {
    files: ['src/lambdas/**/*.ts'],
    rules: { 'import/no-default-export': 'off' },
  },

  // Config files and scripts may use default exports and console.
  {
    files: ['*.config.{js,ts,mjs}', 'scripts/**/*.ts'],
    rules: {
      'import/no-default-export': 'off',
      'no-console': 'off',
    },
  },

  // Test files get relaxed complexity budgets.
  {
    files: ['test/**/*.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      complexity: 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
```

**Rule-group rationale:**

| Group | Why it exists |
|---|---|
| 1. Vertical whitespace | The single highest-leverage readability change in a codebase of this size. A reader scanning a function sees where the work ends and the result begins without reading a line of code. |
| 2. Control flow | `no-else-return` and `no-lonely-if` eliminate the two most common sources of unnecessary nesting. `switch-exhaustiveness-check` turns a missing `case` into a compile error. |
| 3. Complexity budgets | `complexity: 12` and `max-depth: 3` are enforced as errors; the line-count rules are warnings because a 70-line function is a smell, not a defect. |
| 4. Correctness | `no-floating-promises` and `no-misused-promises` are non-negotiable in a serverless codebase — an unawaited `PutItem` becomes a silently dropped write when the Lambda freezes. |
| 5. Imports | `import/extensions` enforces §4.4. `import/no-cycle` catches the design defect that `dependency-cruiser` catches structurally. |
| 6. Boundaries | Architecture §9.2 rules, enforced at lint time. |

**What the vertical-whitespace group produces.** This function is fully lint-compliant; every blank line is enforced, not stylistic preference:

```ts
export async function recordPayment(
  ctx: RequestContext,
  input: RecordPaymentInput,
): Promise<Payment> {
  const lease = await leaseService.getById(ctx, input.leaseId);

  if (!lease) {
    throw new NotFoundError('LEASE_NOT_FOUND');
  }

  const payment = await paymentRepo.update(input.paymentId, {
    amountPaid: input.amountPaid,
    paidAt: input.paidAt,
    status: deriveStatus(input.amountPaid, lease.rentAmount),
  });

  metrics.emit('PaymentRecorded', 1);

  return payment;
}
```

**CI gate:** `pnpm lint` runs with `--max-warnings 0`. A warning is a failure.

### 19.2 TypeScript configuration

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],

    // --- Module resolution ------------------------------------------------
    // Bundler resolution: extensionless relative imports, no NodeNext
    // extension requirement. esbuild is the emitter; tsc is a checker only.
    // See §4.4 for the rationale and §19.3 for the import conventions.
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": false,
    "noEmit": true,

    // --- Strictness -------------------------------------------------------
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,

    // --- Module interop ---------------------------------------------------
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,

    // --- Paths ------------------------------------------------------------
    "paths": { "@/*": ["./src/*"] },
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

**`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are non-negotiable.** They are the two flags that catch the majority of runtime `undefined` bugs in DynamoDB item code, where every field is potentially absent and every array index is potentially out of range.

**`moduleResolution: "Bundler"` replaces the `"NodeNext"` value used in earlier drafts.** The `NodeNext` setting requires a `.js` suffix on every relative import even though the source files are `.ts`, which contradicts §4.4 and the import conventions in §19.3.

**`noEmit: true`** because esbuild produces every deployment artifact. `tsc` (via `tsgo`) is a type checker in this repository, nothing more. If a future build step needs `tsc` to emit, that step gets its own `tsconfig.build.json` that extends this one and overrides `noEmit`.

### 19.3 Import and export conventions

#### 19.3.1 No file extensions

Every relative import and re-export is written **without a file extension**. This applies to `import`, `export ... from`, and dynamic `import()`.

```ts
// Correct
import { propertyService } from '../property';
import { PaymentSchema } from './validators';
export { routes as paymentRoutes } from './routes';
export type { Payment } from './types';

const mod = await import('./heavy-module');
```

```ts
// Forbidden — all rejected by `import/extensions`
import { propertyService } from '../property.ts';
import { propertyService } from '../property.js';
export { routes as paymentRoutes } from './routes.ts';
await import('./heavy-module.js');
```

Package imports are unaffected. `import { Hono } from 'hono'` is correct, and subpath exports declared by a package keep whatever the package specifies.

The rule is enforced by ESLint (`import/extensions`, §19.1 group 5) and by TypeScript (`moduleResolution: "Bundler"` with `allowImportingTsExtensions: false`, §19.2). See §4.4 for the full rationale.

#### 19.3.2 Named exports only

Default exports are forbidden except in Lambda entry points (`src/lambdas/**`) and config files (`*.config.*`).

```ts
// Correct
export const propertyService = { ... };
export class PaymentRepository { ... }

// Forbidden outside src/lambdas/** and *.config.*
export default propertyService;
```

Reasons:

- Renaming a symbol renames every call site. A default export has no name to rename.
- Auto-import in every mainstream editor produces a named import; a default export defeats it.
- `import/no-default-export` catches accidental drift, and the two overrides that disable it are narrow and explicit.

#### 19.3.3 Type-only imports are explicit

`verbatimModuleSyntax: true` (§19.2) requires `import type` for anything erased at compile time. `@typescript-eslint/consistent-type-imports` enforces it and auto-fixes with `eslint --fix`.

```ts
// Correct
import type { Payment } from './types';
import { PaymentSchema, type Payment } from './types';   // inline form, also fine

// Forbidden — Payment is a type, not a value
import { Payment } from './types';
```

The inline form is preferred because it keeps a type and its schema on one line, which is the common case in a module's `validators.ts` and `types.ts`.

#### 19.3.4 Import order

`import/order` groups and sorts imports, with a blank line between groups:

```
1. builtin         node:fs, node:crypto
2. external        hono, zod, @aws-sdk/client-dynamodb
3. internal        @/shared/db, @/modules/lease
4. parent          ../property
5. sibling         ./validators
6. index           .
7. type            import type { ... }
```

Alphabetical, case-insensitive, within each group. `eslint --fix` handles the whole thing.

The blank-line-between-groups behavior is delivered by `newlines-between: 'always'`, which is why the vertical-whitespace group in §19.1 does not need an explicit rule for it.

#### 19.3.5 No cycles

`import/no-cycle` runs alongside `dependency-cruiser` (§19.1 group 5 enforces the rule at lint time; `dependency-cruiser` enforces the structural constraints in CI). A cycle that reaches the module graph is a design defect, not a lint annoyance, and the correct fix is to extract the shared piece into `shared/` or to invert the dependency through a service interface.

### 19.4 Schema evolution

DynamoDB has no migrations. The pattern:

1. Every item carries `schemaVersion`.
2. `migrateItem(entityType, rawItem)` is a pure function mapping `v1 → v2 → ... → current`. It runs on **every read**.
3. If `migrated.schemaVersion !== rawItem.schemaVersion`, the repository schedules a **lazy write-back** (fire-and-forget `UpdateItem`, conditional on `schemaVersion = :oldVersion`).
4. Adding an attribute: bump version, add the migration, deploy. No backfill script needed.
5. Removing an attribute: **never remove.** Stop reading it. Remove it from the type only after all items have been lazily upgraded (verify with a metric).

**Never add a GSI to a hot table during business hours** — `UpdateTable` for GSI creation is non-blocking but consumes capacity from the on-demand pool and can throttle. Do it in the maintenance window (Sunday 03:00 Africa/Casablanca).

### 19.5 Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Files | `kebab-case.ts` | `payment-schedule.ts` |
| Types | `PascalCase` | `PaymentStatus` |
| Functions | `camelCase` | `recordPayment` |
| Constants | `SCREAMING_SNAKE` | `MAX_PAGE_SIZE` |
| Error codes | `SCREAMING_SNAKE` | `PAYMENT_ALREADY_PAID` |
| DynamoDB entities | `PascalCase` single noun | `MaintenanceTicket` |
| Audit actions | `DOMAIN_VERB` | `PAYMENT_RECORDED`, `ADMIN_IMPERSONATE` |
| Queue names | `kebab-case` | `pdf-queue` |
| S3 prefixes | `<type>/<accountId>/<yyyy>/` | `documents/01J.../2025/` |

### 19.6 Definition of Done (per endpoint)

- [ ] Route implemented in `routes.ts` with `zValidator`.
- [ ] Service method in `service.ts`, pure, no AWS SDK imports.
- [ ] Repository methods in `repository.ts`, all keys account-scoped.
- [ ] `accountId` taken from context, never from input.
- [ ] Error codes added to the taxonomy table and to this document.
- [ ] Unit tests for the service (happy + each error branch).
- [ ] Integration test asserting the status code and body shape.
- [ ] **Account-isolation test** added to the parameterized suite.
- [ ] `audit` descriptor added if the route mutates data or is admin-only.
- [ ] `idempotent: true` added if the route creates an entity.
- [ ] Metric emitted if the route represents a business event.
- [ ] OpenAPI spec regenerated; `openapi-diff` shows no breaking change.
- [ ] `pnpm lint` passes with `--max-warnings 0`.
- [ ] No new dependencies without an ADR.
- [ ] Bundle size gate passes.

---

## 20. Implementation Phases

| Phase | Duration | Deliverable | Exit criteria |
|---|---|---|---|
| **P0 — Foundations** | 1 week | Repo scaffold, config, logger, error taxonomy, base repository, ESLint config (§19.1), tsconfig (§19.2), local dev stack, CI pipeline | `pnpm dev` serves `/health`; `pnpm lint` green; CI green on an empty test |
| **P1 — Data layer** | 1 week | All item types, key builders, repositories, `dynamodb-local` integration tests | Table + 2 GSIs created by Terraform; all §7.4 access patterns proven by a test |
| **P2 — Auth** | 1.5 weeks | Register/login/MFA/refresh/logout, JWT, session model, lockout | Token-reuse detection test passes; super-admin single session enforced |
| **P3 — Core CRUD** | 2 weeks | Property, Tenant, Lease, Payment modules + payment schedule generation | End-to-end: register → property → tenant → lease → schedule |
| **P4 — Async** | 1.5 weeks | Job entity, SQS producers, `pdf-worker` (quittance only), `notification-worker` (SES) | Quittance PDF produced from `POST /payments/:id/quittance`; idempotency test passes |
| **P5 — Aggregation** | 1 week | `stream-aggregator`, `SUMMARY#` items, `/dashboard`, `/reports/summary` | Replay-idempotency test passes; dashboard p95 measured |
| **P6 — Documents & PDF breadth** | 1.5 weeks | S3 presigned flows, lease/fiche de police/etat des lieux templates, **Arabic rendering** | Arabic PDF fixture test passes (risk #4 closed) |
| **P7 — Reports** | 1 week | `report-worker`, xlsx + pdf export | 10k-row export completes within 120 s |
| **P8 — Admin & hardening** | 1 week | `/admin/*`, impersonation, audit log, rate limits, security headers, ZAP scan | ZAP baseline: zero medium+ findings |
| **P9 — Load & cutover** | 1 week | k6 smoke, prod Terraform, alarms, runbook | p95 `<= 400 ms`, p99 `<= 1000 ms` at 100 concurrent users |

**Total: ~11.5 weeks** for one senior engineer, ~7 weeks for two working in parallel from P3 onward.

**Critical path:** P1 → P2 → P3 → P4. P6 (Arabic PDF) must start no later than week 4 because it is the highest-uncertainty item (Architecture risk #4).

---

## 21. Open Questions for the Architect

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| Q1 | Approve `notification-worker` on its own queue/DLQ and the corrected deployed count (C-1)? | §11.4 | Yes — 6 functions total including authorizer |
| Q2 | Approve account-scoped GSI key prefixes (C-2)? | §7.2 | Yes — security |
| Q3 | Approve tenant-lease link items instead of a third GSI (C-3)? | §7.2 | Yes — cheaper |
| Q4 | Approve globally unique normalized email and the `SYSTEM` email directory (C-4)? | §8.1 | Yes — identifiers only, conditionally claimed at registration |
| Q5 | Approve SQS visibility timeout values (C-7)? | §11.1 | Yes — PDF 360 s, report 720 s, notification 180 s |
| Q6 | Is `nodejs26.x` GA in `eu-west-1`? (C-6) | §17.2 | Fall back to newest GA LTS |
| Q7 | Twilio monthly cap value — 500 messages? | §11.4 | 500 |
| Q8 | Is Arabic UI required at launch, or post-launch? | §11.2 | Post-launch (BRD rule #14 lists FR + EN only) |
| Q9 | Data residency: is Ireland acceptable for Moroccan personal data, or is a Moroccan region required? | §18 | Ireland per Architecture §6.1 |
| Q10 | Who owns the `/internal/*` HMAC key, and how is it rotated? | §14.6 | Platform team, annual |
| Q11 | Is a `dev` environment permitted to send real Twilio/SES messages? | §16 | No — localstack only in dev |
| Q12 | Approve consumed-token markers and revoke only on confirmed refresh-token replay (C-5)? | §7.3.11, §8.1 | Yes — invalid unknown tokens do not revoke sessions |

---

## 22. Appendix A — Entity / Key Quick Reference

```
PK                          SK                                  Entity
─────────────────────────────────────────────────────────────────────────────────
ACCOUNT#<aid>               META                                Account
ACCOUNT#<aid>               USER#<uid>                          User
ACCOUNT#<aid>               PROPERTY#<pid>                      Property
ACCOUNT#<aid>               TENANT#<tid>                        Tenant
ACCOUNT#<aid>               LEASE#<lid>                         Lease
ACCOUNT#<aid>               PAYMENT#<pmid>                      Payment
ACCOUNT#<aid>               DOC#<did>                           Document
ACCOUNT#<aid>               TICKET#<tcid>                       MaintenanceTicket
ACCOUNT#<aid>               JOB#<jid>                           Job
ACCOUNT#<aid>               SUMMARY#<yyyy-mm>                   Summary
ACCOUNT#<aid>               COUNTER#quittance                   Counter
ACCOUNT#<aid>               COUNTER#whatsapp#<yyyy-mm>          Counter
ACCOUNT#<aid>               LINK#TENANT#<tid>#LEASE#<lid>       TenantLeaseLink
ACCOUNT#<aid>               IDEMPOTENCY#<key>                   IdempotencyRecord
ACCOUNT#<aid>               PROCESSED#<eventId>                 ProcessedEvent
SESSION#<uid>               USED#<tokenHash>                    ConsumedRefreshToken
AUDIT#<aid>                 <iso>#<ulid>                        AuditLog
- Refresh token rotation: use token → rotate → replay a consumed token → `SESSION_REVOKED`; an unrecognized invalid token returns `INVALID_REFRESH` without revoking the session.
SESSION#<uid>               ACTIVE                              Session
OTP#<uid>                   LOGIN_MFA | PASSWORD_RESET          Otp
SYSTEM                      EMAIL#<email>                       EmailIndex
```

**GSI1** (projection `ALL`) — `GSI1PK` / `GSI1SK`

```
ACCOUNT#<aid>#PROPERTY#<pid>   LEASE#<startDate>#<lid>       → leases for a property
ACCOUNT#<aid>#LEASE#<lid>      PAYMENT#<dueDate>#<pmid>      → payments for a lease
ACCOUNT#<aid>#LEASE#<lid>      DOC#<type>#<createdAt>#<did>  → documents for a lease
ACCOUNT#<aid>#ACCOUNT#<aid>    TENANT#<sortName>#<tid>        → sorted tenant directory
```

**GSI2** (projection `KEYS_ONLY`) — `GSI2PK` / `GSI2SK`

```
ACCOUNT#<aid>#STATUS#due|partial|paid|late|cancelled   <dueDate>#<pmid>       → payments by status
ACCOUNT#<aid>#STATUS#open|in_progress|resolved|closed  <prio>#<createdAt>#<tcid> → tickets by status
ACCOUNT#<aid>#STATUS#draft|active|terminated|expired   <startDate>#<lid>      → leases by status
ACCOUNT#<aid>#STATUS#queued|processing|succeeded|failed  <createdAt>#<jid>    → jobs by status
ACCOUNT#<aid>#EMAIL#<email>                            USER#<uid>             → login lookup
```

---

## 23. Appendix B — Domain Event Catalog

Events are **not** an external API. They are internal signals published as DynamoDB stream records and SQS messages.

| Event | Source | Consumer | Effect |
|---|---|---|---|
| `PaymentRecorded` | DynamoDB Stream (INSERT on `Payment`) | `stream-aggregator` | `SUMMARY#` income delta |
| `PaymentStatusChanged` | DynamoDB Stream (MODIFY on `Payment`) | `stream-aggregator` | `latePayments`/`paidPayments` delta |
| `PaymentPeriodChanged` | DynamoDB Stream (MODIFY, `periodStart` differs) | `stream-aggregator` | Reverse old month, apply new month |
| `LeaseActivated` | DynamoDB Stream | `stream-aggregator` | `occupiedProperties` +1 |
| `LeaseTerminated` | DynamoDB Stream | `stream-aggregator` | `occupiedProperties` −1 |
| `PropertyCreated` / `PropertyArchived` | DynamoDB Stream | `stream-aggregator` | `totalProperties` ±1 |
| `TicketStatusChanged` | DynamoDB Stream | `stream-aggregator` | `openTickets` delta |
| `DocumentReady` | `pdf-worker` / `report-worker` → SQS | `notification-worker` | Email owner with link |
| `RentReminderDue` | EventBridge → internal route | `notification-worker` | Reminder |
| `RentOverdue` | EventBridge → internal route | `notification-worker` | Overdue notice |
| `LeaseExpiring` | EventBridge → internal route | `notification-worker` | Renewal nudge |
| `SecurityEvent` | `auth` module (in-process) | — | `AUDIT#` item |

Every event payload MUST carry `{ eventId, occurredAt, accountId, entityType, entityId, schemaVersion }`.

---

## 24. Appendix C — Non-Functional Traceability

| NFR | Backend mechanism | Verification |
|---|---|---|
| p50 `<= 150 ms` | DynamoDB single-digit ms, no cold-start dependency for warm paths | EMF `ApiLatency` p50 |
| p95 `<= 400 ms` | Single Lambda, in-process cross-module calls | EMF p95, k6 |
| p99 `<= 1000 ms` | 1 cold-start surface; keep-alive SDK clients; module-scope caching | EMF p99 |
| PDF `<= 10 s` | SQS + 1024 MB worker; warm Chromium reuse | `Job.startedAt → finishedAt` |
| Report `<= 20 s` | Pre-aggregated summaries; streaming workbook writer | same |
| Upload `<= 5 s` for `<= 10 MB` | Direct-to-S3 presigned PUT; never through Lambda | manual + k6 |
| RPO `<= 5 min` | DynamoDB PITR | restore drill quarterly |
| RTO `<= 4 h` | Terraform redeploy + Lambda alias rollback | restore drill quarterly |
| 10-year retention | Soft deletes; S3 lifecycle to Glacier at 2y | S3 `GetBucketLifecycle` test |
| Account isolation | Account-scoped keys + account-scoped GSIs (C-2) | parameterized isolation test suite |
| `$20/month` | EMF metrics, no X-Ray, no KMS CMK, no NAT, on-demand only, Twilio cap | AWS Budgets + monthly review |
| Developer onboarding | Uniform ESLint config (§19.1), extensionless imports (§4.4, §19.3), named exports (§19.3.2) | `pnpm lint` in CI; PR review |

---

## 25. Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Engineering Lead | | | |
| Solution Architect | | | |
| Senior Business Analyst | | | |
| Product Owner | | | |

---