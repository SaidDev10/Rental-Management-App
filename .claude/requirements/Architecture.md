# Architecture Document
## Rental Management App

**Version:** 2.0
**Status:** Draft
**Prepared by:** Solution Architect
**Date:** [Insert date]
**Companion documents:** BRD v1.1, NFR v2.1

---

## 1. Executive Summary

This document describes the technical architecture for the Rental Management App — a web-based application for individual property owners in Morocco to manage short-term and long-term residential rentals.

This architecture follows a **Serverless Modular Monolith** pattern: a single Hono application running in a single AWS Lambda function, backed by a DynamoDB single-table design, with async workers for PDF generation, reporting, and notifications. All infrastructure is defined in Terraform and deployed to AWS `eu-west-1` (Ireland).

This architecture was selected because it:

- Comfortably fits the **<= $20/month infrastructure budget** mandated by the NFR.
- Supports **<= 100 concurrent users** with zero capacity planning.
- Meets **99.5% uptime**, **RTO <= 4h**, and **RPO <= 5min** targets.
- Minimizes cold-start surface (1 API Lambda instead of 9+).
- Keeps operational complexity low for a **1-3 person team**.
- Uses **only current, non-deprecated framework versions**.

---

## 2. Architecture Overview

### 2.1 Architecture Style

**Serverless Modular Monolith with a Single Hono API Lambda.**

- **Modular monolith** — one codebase, one deployment pipeline, one data store. Business logic is organized into modules with explicit boundaries enforced by Hono sub-apps and ESLint rules.
- **Single API Lambda** — all synchronous HTTP routes are handled by one Hono application in one Lambda. Cross-module calls are in-process function calls, not Lambda-to-Lambda HTTP calls.
- **Async workers remain separate** — PDF generation, report export, and stream aggregation run in dedicated Lambdas triggered by SQS or DynamoDB Streams, because they have different memory/timeout profiles and must not block API requests.
- **Single-table DynamoDB** — all entities live in one table, isolated by `account_id` in the partition key.

### 2.2 High-Level Architecture

```
+------------------------------------------------------------------------------+
|                                  End Users                                   |
|                    (Property Owners - Super Admin)                           |
+-----------------------------------+------------------------------------------+
                                    |
                                    | HTTPS
                                    v
+------------------------------------------------------------------------------+
|                              Route 53 (DNS)                                  |
+-----------------------------------+------------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------------+
|                     CloudFront (CDN + TLS termination)                       |
|                                                                              |
|   +------------------------------+        +-----------------------------+    |
|   |  Static SPA (S3 origin)      |        |  API (API Gateway origin)   |    |
|   |  React 19 + Vite 8 build     |        |  /api/*                     |    |
|   +------------------------------+        +--------------+--------------+    |
+-----------------------------------------------------------+------------------+
                                                            |
                                                            v
+------------------------------------------------------------------------------+
|                    API Gateway (HTTP API - cheaper than REST)                |
|                                                                              |
|   Route:  ANY /{proxy+}  ->  api-handler Lambda                              |
|   Authorizer: Lambda (JWT verification)                                      |
|   Throttling: 100 req/s burst, 50 req/s steady                               |
+-----------------------------------+------------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------------+
|                    Lambda: api-handler (Hono v4.13+)                         |
|                                                                              |
|   Hono app with sub-apps:                                                    |
|   /auth  /properties  /tenants  /leases  /payments                           |
|   /documents  /maintenance  /reports  /admin                                 |
|                                                                              |
|   Middleware chain:                                                          |
|   error-handler -> auth -> account-scope -> role-guard -> audit -> route     |
|                                                                              |
|   In-process cross-module calls (e.g., payment-service -> lease-service)     |
+-------+----------------------------------------------------------------------+
        |
        |  +----------------------------------------------------------+
        |  |  Async path (enqueue, return 202)                        |
        |  |                                                          |
        |  |  POST /payments        -> write Payment -> SQS pdf-queue |
        |  |  POST /reports/export  -> SQS report-queue               |
        |  +----------------------------------------------------------+
        |
        v
+------------------------------------------------------------------------------+
|                           AWS Services (eu-west-1)                           |
|                                                                              |
|  +--------------+  +--------------+  +--------------+  +--------------+      |
|  |  DynamoDB    |  |  S3          |  |  SES         |  |  SSM         |      |
|  |  (single     |  |  (documents, |  |  (email)     |  |  (secrets)   |      |
|  |   table)     |  |   photos,    |  |              |  |              |      |
|  |              |  |   PDFs)      |  |              |  |              |      |
|  +------+-------+  +--------------+  +--------------+  +--------------+      |
|         |                                                                     |
|         | DynamoDB Streams                                                    |
|         v                                                                     |
|  +--------------+  +--------------+  +--------------+  +--------------+      |
|  |  Lambda:     |  |  SQS         |  |  Lambda:     |  |  Twilio      |      |
|  |  stream-     |  |  pdf-queue   |->|  pdf-worker  |->|  (WhatsApp)  |      |
|  |  aggregator  |  |  report-     |->|  report-     |  |              |      |
|  |              |  |  queue       |  |  worker      |  |              |      |
|  +--------------+  +--------------+  +--------------+  +--------------+      |
|                                                                              |
|  +--------------+  +--------------+                                          |
|  |  CloudWatch  |  |  Sentry      |                                          |
|  |  (logs,      |  |  (error      |                                          |
|  |   metrics,   |  |   tracking)  |                                          |
|  |   alarms)    |  |              |                                          |
|  +--------------+  +--------------+                                          |
+------------------------------------------------------------------------------+
```

### 2.3 Lambda Topology

| Lambda | Trigger | Purpose | Runtime | Memory | Timeout |
|--------|---------|---------|---------|--------|---------|
| **`api-handler`** | API Gateway (`ANY /{proxy+}`) | **All synchronous routes** (Hono app) | `nodejs26.x` | 1024 MB | 29s |
| `pdf-worker` | SQS `pdf-queue` | PDF generation (lease, quittance, etc.) | `nodejs26.x` | 1024 MB | 60s |
| `report-worker` | SQS `report-queue` | Excel/PDF report export | `nodejs26.x` | 1024 MB | 120s |
| `notification-worker` | SQS `notification-queue` | Email/WhatsApp dispatch and retry handling | `nodejs26.x` | 512 MB | 30s |
| `stream-aggregator` | DynamoDB Streams | Update summary items | `nodejs26.x` | 512 MB | 30s |

**Total: 5 Lambdas.**

**Design rationale:**

- **Single API Lambda** — one cold start warms the entire API. Users navigating between properties, leases, and payments never hit a cold start after the first request. This directly improves p95/p99 NFR targets.
- **Async workers separate** — PDF generation (60s timeout, 1024 MB), report export (120s timeout), and notification dispatch (30s timeout, 512 MB) must not block API requests. SQS decoupling means API routes return `202 Accepted` immediately.
- **Notification dispatch has separate failure modes** — SES/Twilio HTTP calls are rate-limited and retry-sensitive, so they must not share a DLQ with PDF rendering.
- **Stream aggregator separate** — triggered by DynamoDB Streams, not HTTP. Different event shape, different IAM role.

### 2.4 Architectural Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| 1 | **Serverless-first** | Pay-per-use, scale-to-zero, no patching — required to fit $20/month budget. |
| 2 | **Single Hono API Lambda** | Minimizes cold-start surface; enables in-process cross-module calls; simplifies deployment. |
| 3 | **Single-table DynamoDB** | Mandated by NFR; cheapest managed DB; no idle cost. |
| 4 | **Account-scoped isolation** | Every item keyed by `account_id`; enforced at the repository layer. |
| 5 | **Modules own their data** | No cross-module repository access; communicate via service interfaces or events. |
| 6 | **Async for slow work** | PDF and report generation run on SQS-triggered workers, never in the request path. |
| 7 | **Pre-aggregate for reporting** | DynamoDB Streams -> aggregation items; no scan-based reporting. |
| 8 | **Infrastructure as Code** | Terraform manages all AWS resources; state in S3 + DynamoDB lock. |
| 9 | **Cost-aware by default** | Every design decision weighed against the $20/month ceiling. |
| 10 | **Current framework versions only** | No deprecated runtimes or libraries. |

---

## 3. System Components

### 3.1 Frontend

| Aspect | Decision |
|--------|----------|
| **Framework** | **React 19.3.0** |
| **Build tool** | **Vite 8.1** (Rolldown-powered) |
| **Language** | **TypeScript 7.0.2** |
| **Hosting** | S3 + CloudFront (free tier: 1 TB egress, 10M requests/month) |
| **Routing** | React Router v7 (or TanStack Router) |
| **State** | TanStack Query for server state; Zustand for minimal client state |
| **Styling** | Tailwind CSS v4 |
| **i18n** | French + English UI (per BRD rule #14) |
| **Auth** | JWT in memory + refresh token in httpOnly cookie |
| **Responsive** | Desktop, tablet, mobile browser (per BRD section 4.11) |
| **Analytics** | Google Analytics |

**Feature folders** mirror backend modules: `auth`, `properties`, `tenants`, `leases`, `payments`, `documents`, `maintenance`, `reports`, `dashboard`, `admin`.

### 3.2 API Layer

| Aspect | Decision |
|--------|----------|
| **Service** | API Gateway **HTTP API** (not REST API — cheaper) |
| **Cost** | ~$1/million requests |
| **Routing** | Single catch-all: `ANY /{proxy+}` -> `api-handler` |
| **Auth** | Lambda authorizer (JWT verification) |
| **Validation** | Hono Zod validator middleware (in-process) |
| **Rate limiting** | API Gateway throttling (built-in, free) |
| **CORS** | Configured per environment |

**Why REST over GraphQL/gRPC?**

- REST is simpler and cheaper. GraphQL would require AppSync (~$0.50/million ops).
- gRPC requires gRPC-Web + proxy for browser support — unnecessary complexity.
- Events are used **internally** (DynamoDB Streams), not as the external API contract.

### 3.3 Compute — Hono API Lambda

**Framework:** Hono v4.13+
**Adapter:** `@hono/aws-lambda` v1.0+
**Runtime:** `nodejs26.x` (AWS Lambda)

**Why Hono?**

- Tiny (~14KB), zero dependencies, extremely fast routing.
- First-class Lambda support via `@hono/aws-lambda`.
- Sub-app composition gives you modularity without deployment complexity.
- Middleware system (auth, validation, logging) is built-in and composable.
- Type-safe RPC client generation for frontend (`hc<typeof app>`).

**Hono app structure:**

```typescript
// src/app.ts
import { Hono } from 'hono';
import { propertyRoutes } from './modules/property';
import { leaseRoutes } from './modules/lease';
// ...

const app = new Hono();

app.route('/auth', authRoutes);
app.route('/properties', propertyRoutes);
app.route('/leases', leaseRoutes);
app.route('/payments', paymentRoutes);
// ...

export { app };
```

```typescript
// src/lambdas/api-handler.ts
import { handle } from '@hono/aws-lambda';
import { app } from '../app';

export const handler = handle(app);
```

**Middleware chain (applied to all routes):**

```
Request
  -> error-handler      (catches all errors -> JSON response)
  -> auth               (verify JWT, extract user + account_id)
  -> account-scope      (inject account_id into context)
  -> role-guard         (owner vs super_admin)
  -> audit              (log action for Super Admin / sensitive ops)
  -> route handler      (module sub-app)
Response
```

### 3.4 Data Layer — DynamoDB

See section 4 for the full schema.

| Aspect | Decision |
|--------|----------|
| **Service** | Amazon DynamoDB |
| **Capacity** | On-demand (no idle cost) |
| **Table** | Single table: `rental-app-main` |
| **Indexes** | GSI1 (property/lease lookups), GSI2 (status lookups) |
| **Streams** | Enabled — feeds `stream-aggregator` |
| **PITR** | Enabled (35-day continuous backup) — satisfies RPO <= 5min |
| **Encryption** | AWS-owned key (default, free) |
| **Backups** | PITR + on-demand backups before migrations |
| **TTL** | Enabled for OTP codes, sessions |

### 3.5 Storage — S3

| Bucket | Purpose | Lifecycle |
|--------|---------|-----------|
| `rental-app-documents-prod` | Leases, quittances, fiche de police, etat des lieux, invoices | Standard -> IA after 90d -> Glacier after 2y (10-year retention) |
| `rental-app-photos-prod` | Property photos | Standard -> IA after 90d |
| `rental-app-frontend-prod` | SPA build artifacts | No lifecycle |
| `rental-app-tfstate-prod` | Terraform state | Versioned, no lifecycle |

**Access:**

- All buckets block public access.
- Documents accessed via **presigned URLs** (direct-to-S3 upload/download).
- CloudFront serves frontend assets and (optionally) document downloads.

### 3.6 Async Processing

| Queue | Trigger | Consumer | Purpose |
|-------|---------|----------|---------|
| `pdf-queue` | API Lambda (lease/payment handlers) | `pdf-worker` | Generate lease, quittance, fiche de police, etat des lieux |
| `report-queue` | API Lambda (reporting handler) | `report-worker` | Generate Excel/PDF exports |
| `notification-queue` | DynamoDB Streams / EventBridge | `notification-worker` | Send email/WhatsApp reminders and alerts |

**Retry policy:** 3 attempts, then DLQ. DLQs monitored via CloudWatch alarms.

### 3.7 Notifications

| Channel | Service | Use Case |
|---------|---------|----------|
| Email | AWS SES | Transactional emails, MFA OTP, rent reminders |
| WhatsApp | Twilio | Owner reminders for unpaid rent (template-based) |

**Cost control:** Hard monthly cap in Twilio console; WhatsApp restricted to critical alerts only (rent overdue, lease expiring).

### 3.8 Monitoring & Observability

| Concern | Tool |
|---------|------|
| Metrics & dashboards | CloudWatch (free tier) |
| Logs | CloudWatch Logs (structured JSON) |
| Alarms | CloudWatch Alarms (budget, error rate, DLQ depth) |
| Error tracking | Sentry (free tier) |
| Budget alerts | AWS Budgets at 80% ($16) and 100% ($20) |
| Audit logs | DynamoDB `AUDIT#` items, 10-year retention |

---

## 4. Data Model — DynamoDB Single-Table Design

### 4.1 Table Configuration

| Setting | Value |
|---------|-------|
| Table name | `rental-app-main` |
| Partition key | `PK` (String) |
| Sort key | `SK` (String) |
| Billing mode | On-demand |
| Streams | `NEW_AND_OLD_IMAGES` |
| PITR | Enabled |
| TTL attribute | `ttl` |

### 4.2 Key Design

All items for an account are prefixed with `ACCOUNT#<accountId>` in the PK, guaranteeing account isolation and efficient single-partition queries.

**Primary key patterns:**

| Entity | PK | SK |
|--------|----|----|
| Account | `ACCOUNT#<id>` | `META` |
| User | `ACCOUNT#<id>` | `USER#<id>` |
| Property | `ACCOUNT#<id>` | `PROPERTY#<id>` |
| Tenant | `ACCOUNT#<id>` | `TENANT#<id>` |
| Lease | `ACCOUNT#<id>` | `LEASE#<id>` |
| Payment | `ACCOUNT#<id>` | `PAYMENT#<id>` |
| Document | `ACCOUNT#<id>` | `DOC#<id>` |
| Maintenance Ticket | `ACCOUNT#<id>` | `TICKET#<id>` |
| Quittance Counter | `ACCOUNT#<id>` | `COUNTER#quittance` |
| Summary (monthly) | `ACCOUNT#<id>` | `SUMMARY#<yyyy-mm>` |
| Session | `SESSION#<userId>` | `ACTIVE` |
| OTP | `OTP#<userId>` | `<purpose>` |
| Audit Log | `AUDIT#<accountId>` | `<timestamp>#<id>` |
| Email lookup | `SYSTEM` | `EMAIL#<normalizedEmail>` |

### 4.3 Global Secondary Indexes

**GSI1 — Account-scoped property / lease / tenant lookups**

| Attribute | Value |
|-----------|-------|
| GSI1-PK | `ACCOUNT#<accountId>#PROPERTY#<propertyId>` or `ACCOUNT#<accountId>#LEASE#<leaseId>` or `ACCOUNT#<accountId>#TENANT#<tenantId>` or `ACCOUNT#<accountId>#ACCOUNT#<accountId>` |
| GSI1-SK | Entity-specific sort (e.g., `LEASE#<startDate>`, `PAYMENT#<dueDate>`, `TENANT#<sortName>#<id>`) |
| Projection | `ALL` |

Supports:

- List leases for a property within one account
- List payments for a lease within one account
- List documents for a lease within one account
- List tenants (by name) within one account

**GSI2 — Account-scoped status and email lookup**

| Attribute | Value |
|-----------|-------|
| GSI2-PK | `ACCOUNT#<accountId>#STATUS#<status>` or `ACCOUNT#<accountId>#EMAIL#<lowercasedEmail>` |
| GSI2-SK | `<dueDate>#<id>` for statuses, or `USER#<userId>` for user login lookup |
| Projection | `KEYS_ONLY` (fetch full item from base table) |

Supports:

- List all late payments for an account
- List all due payments for an account
- List open maintenance tickets for an account
- Login by email to a specific account/user within the same tenant partition

### 4.4 Access Patterns

| # | Access Pattern | Index | Query |
|---|----------------|-------|-------|
| 1 | Get account metadata | Base | PK=`ACCOUNT#<id>`, SK=`META` |
| 2 | List all properties | Base | PK=`ACCOUNT#<id>`, SK begins_with `PROPERTY#` |
| 3 | List all tenants | Base | PK=`ACCOUNT#<id>`, SK begins_with `TENANT#` |
| 4 | List all leases | Base | PK=`ACCOUNT#<id>`, SK begins_with `LEASE#` |
| 5 | List all payments | Base | PK=`ACCOUNT#<id>`, SK begins_with `PAYMENT#` |
| 6 | List leases for a property | GSI1 | GSI1-PK=`ACCOUNT#<accountId>#PROPERTY#<propId>` |
| 7 | List payments for a lease | GSI1 | GSI1-PK=`ACCOUNT#<accountId>#LEASE#<leaseId>` |
| 8 | List documents for a lease | GSI1 | GSI1-PK=`ACCOUNT#<accountId>#LEASE#<leaseId>`, SK begins_with `DOC#` |
| 9 | List late payments | GSI2 | GSI2-PK=`ACCOUNT#<accountId>#STATUS#late` |
| 10 | List due payments | GSI2 | GSI2-PK=`ACCOUNT#<accountId>#STATUS#due` |
| 11 | List open tickets | GSI2 | GSI2-PK=`ACCOUNT#<accountId>#STATUS#open` |
| 12 | Get monthly summary | Base | PK=`ACCOUNT#<id>`, SK=`SUMMARY#<yyyy-mm>` |
| 13 | Atomic quittance number | Base | `UpdateItem` with `ADD` on `COUNTER#quittance` |

### 4.5 Reporting Strategy

**Problem:** DynamoDB cannot do ad-hoc aggregation (no `SUM`, `GROUP BY`).

**Solution:** Pre-aggregate via DynamoDB Streams.

```
Payment written -> DynamoDB Stream -> stream-aggregator Lambda
                                   -> Update SUMMARY#<yyyy-mm> item
                                      (increment income, update status counts)
```

**Summary item example:**

```json
{
  "PK": "ACCOUNT#abc123",
  "SK": "SUMMARY#2025-03",
  "totalIncome": 45000,
  "totalExpenses": 3200,
  "netYield": 41800,
  "occupiedProperties": 8,
  "totalProperties": 10,
  "latePayments": 2,
  "paidPayments": 18,
  "updatedAt": "2025-03-31T23:59:59Z"
}
```

**Trade-off accepted:** No real-time ad-hoc queries. Reports are as fresh as the last stream event (typically < 1s).

### 4.6 Quittance Numbering (Legal Requirement)

Quittances must be **auto-numbered sequentially per owner** (BRD rule #10).

**Implementation:**

```typescript
// Atomic increment — guaranteed unique, sequential
const result = await dynamo.send(new UpdateItemCommand({
  TableName: 'rental-app-main',
  Key: { PK: `ACCOUNT#${accountId}`, SK: 'COUNTER#quittance' },
  UpdateExpression: 'ADD #n :inc',
  ExpressionAttributeNames: { '#n': 'nextNumber' },
  ExpressionAttributeValues: { ':inc': 1 },
  ReturnValues: 'UPDATED_NEW',
}));
const quittanceNumber = result.Attributes.nextNumber;
```

This is atomic and race-free — two concurrent payment recordings will get different numbers.

### 4.7 Data Retention

- **10-year retention** (BRD rule #13): S3 lifecycle policies move documents to Glacier after 2 years; DynamoDB items are never deleted (soft-delete via `status: archived`).
- **Account deletion** (BRD rule #15): soft-delete only — account `status` set to `disabled`, all data retained.
- **OTP / session TTL:** DynamoDB TTL automatically deletes expired items.

---

## 5. Security Architecture

### 5.1 Authentication

| Mechanism | Implementation |
|-----------|----------------|
| Primary auth | Email + password |
| Password hashing | Argon2id (fallback: bcrypt cost >= 12) |
| Password policy | Min 12 chars, complexity check, HaveIBeenPwned breach check |
| MFA | Email OTP via SES (6-digit, 5-min TTL, rate-limited) |
| Social login | Google OAuth 2.0 |
| Session tokens | JWT access token (15 min) + refresh token (30 days, rotated, single-use) |
| Account lockout | 5 failed attempts -> 15-min lockout |

**JWT strategy:**

- **Algorithm:** RS256 (asymmetric — public key shared with frontend for verification).
- **Claims:** `sub` (userId), `account_id`, `role` (`owner` or `super_admin`), `exp`, `iat`, `jti`.
- **Storage:** Access token in memory (frontend); refresh token in httpOnly, Secure, SameSite=Strict cookie.
- **Rotation:** Refresh token rotated on every use. The `SESSION#<userId>/ACTIVE` item stores the current refresh-token hash; a replayed or reused token is rejected and the session is revoked, with a `SecurityEvent` audit item written in the same flow.

### 5.2 Authorization

| Layer | Enforcement |
|-------|-------------|
| **Account isolation** | Every DynamoDB item keyed by `ACCOUNT#<accountId>`; repository layer forces `account_id` from JWT. |
| **API authorization** | Every endpoint checks ownership — no IDOR vulnerabilities. |
| **Super Admin** | Route namespace `/admin/*` with role-guard middleware. |
| **Impersonation** | Read-only (no write endpoints), time-boxed (<= 30 min), fully audit-logged. |
| **Single Super Admin session** | DynamoDB session lock — new login invalidates previous session. |

**Middleware chain (every request):**

```
1. Verify JWT (signature, expiry)
2. Extract account_id + role
3. Enforce route-level role check (owner vs. super_admin)
4. Pass account_id to service layer
5. Service layer scopes all repository calls to account_id
```

### 5.3 Data Encryption

| Data State | Mechanism |
|------------|-----------|
| In transit | TLS 1.2+ (prefer TLS 1.3), HSTS enabled |
| DynamoDB at rest | AWS-owned key (default, free) |
| S3 at rest | SSE-S3 (free) |
| Backups | Encrypted (same standard as primary) |
| Sensitive fields (CIN/passport) | Application-level encryption before DynamoDB write |
| Secrets | AWS SSM Parameter Store (free tier) |

### 5.4 Compliance

| Requirement | Approach |
|-------------|----------|
| **Moroccan Law 09-08** | CNDP registration, privacy policy, data subject access, breach notification |
| **GDPR-aligned practices** | Data minimization, right to access, breach notification |
| **Data residency** | AWS `eu-west-1` (Ireland) |
| **Audit logging** | All Super Admin actions logged, retained 10 years |
| **Data retention** | 10 years, enforced via S3 lifecycle + DynamoDB soft-delete |

### 5.5 Application Security

| Concern | Mitigation |
|---------|------------|
| OWASP Top 10 | Input validation (Zod), parameterized queries (DynamoDB), CSP, CSRF tokens |
| Dependency scanning | Dependabot (free on GitHub) |
| File uploads | MIME type + size validation; S3 bucket blocks public access; presigned URLs only |
| Rate limiting | API Gateway throttling (built-in, free) |
| Penetration testing | Deferred (cost-prohibitive at $20/month); OWASP ZAP free tier in CI |

---

## 6. Deployment Architecture

### 6.1 AWS Region

**Primary region:** `eu-west-1` (Ireland)

**Rationale:**

- Cheapest EU region.
- ~50-60 ms latency to Morocco.
- Data residency within EU (compatible with Law 09-08 and future GDPR alignment).

**DR region:** `eu-west-3` (Paris) — daily encrypted backups only (no active failover at this budget).

### 6.2 Deployment Topology

```
+-----------------------------------------------------------------------+
|                          AWS eu-west-1                                |
|                                                                       |
|  +-----------------------------------------------------------------+  |
|  |  Route 53 (rental-app.ma)                                       |  |
|  +----------------------------+------------------------------------+  |
|                               |                                       |
|  +----------------------------v------------------------------------+  |
|  |  CloudFront Distribution                                        |  |
|  |  - Origin 1: S3 (frontend SPA)                                  |  |
|  |  - Origin 2: API Gateway (API)                                  |  |
|  |  - ACM certificate (TLS)                                        |  |
|  +----------------------------+------------------------------------+  |
|                               |                                       |
|  +----------------------------v------------------------------------+  |
|  |  API Gateway (HTTP API)                                         |  |
|  |  - Catch-all route: ANY /{proxy+} -> api-handler                |  |
|  |  - Lambda authorizer (JWT)                                      |  |
|  |  - Throttling: 100 req/s burst, 50 req/s steady                 |  |
|  +----------------------------+------------------------------------+  |
|                               |                                       |
|  +----------------------------v------------------------------------+  |
|  |  Lambda Functions (5 total)                                     |  |
|  |  - api-handler (Hono, all sync routes)                          |  |
|  |  - pdf-worker (SQS-triggered)                                   |  |
|  |  - report-worker (SQS-triggered)                                |  |
|  |  - notification-worker (SQS-triggered)                          |  |
|  |  - stream-aggregator (DynamoDB Streams-triggered)               |  |
|  +----------------------------+------------------------------------+  |
|                               |                                       |
|  +----------------------------v------------------------------------+  |
|  |  DynamoDB (single table + 2 GSIs + PITR + Streams)              |  |
|  |  S3 (documents, photos, frontend, tfstate)                      |  |
|  |  SQS (pdf-queue, report-queue, notification-queue + DLQs)     |  |
|  |  SES (email)                                                    |  |
|  |  SSM Parameter Store (secrets)                                  |  |
|  |  CloudWatch (logs, metrics, alarms)                             |  |
|  +-----------------------------------------------------------------+  |
|                                                                       |
|  External: Twilio (WhatsApp), Google OAuth, Sentry                    |
+-----------------------------------------------------------------------+
```

### 6.3 Infrastructure as Code

**Tool:** Terraform
**State backend:** S3 (`rental-app-tfstate-prod`) + DynamoDB lock table (`rental-app-tflock`)

**Module structure:**

```
infrastructure/
|-- modules/
|   |-- api-gateway/       # HTTP API, catch-all route, authorizer, throttling
|   |-- lambda/            # 5 Lambda functions, IAM roles, env vars
|   |-- dynamodb/          # Table, GSIs, streams, PITR, backups
|   |-- s3/                # Buckets, lifecycle, policies, encryption
|   |-- cloudfront/        # Distribution, origins, ACM cert
|   |-- ses/               # Verified identities, templates
|   |-- sqs/               # Queues, DLQs, alarms
|   |-- secrets/           # SSM parameters
|   |-- monitoring/        # CloudWatch alarms, dashboards
|   |-- iam/               # Shared roles, policies
|-- environments/
|   |-- dev/
|   |-- prod/
|-- backend.tf
```

### 6.4 CI/CD Pipeline

**Tool:** GitHub Actions (free tier)

| Workflow | Trigger | Steps |
|----------|---------|-------|
| `frontend-ci.yml` | Push to `frontend/**` | Lint -> Typecheck -> Test -> Build |
| `backend-ci.yml` | Push to `backend/**` | Lint -> Typecheck -> Test -> Bundle (esbuild) |
| `deploy-dev.yml` | Merge to `develop` | Terraform plan/apply -> Deploy Lambda -> Sync S3 -> Invalidate CloudFront |
| `deploy-prod.yml` | Release tag (`v*`) | Terraform plan/apply (manual approval) -> Deploy Lambda -> Sync S3 -> Invalidate CloudFront |

**Deployment order:**

1. Terraform apply (infrastructure changes).
2. Backend bundle + Lambda deploy (4 functions).
3. Frontend build + S3 sync.
4. CloudFront invalidation.
5. Smoke tests.

### 6.5 Environments

| Environment | Purpose | Data | Budget |
|-------------|---------|------|--------|
| **dev** | Development, testing | Synthetic data | ~$5/month |
| **prod** | Production | Real data | ~$10-15/month |

No staging environment — cost-prohibitive at this budget. Dev is used for pre-production validation.

---

## 7. Non-Functional Requirements — Satisfaction

| NFR | Target | How Satisfied |
|-----|--------|---------------|
| **Availability** | 99.5% uptime | Serverless (Lambda + DynamoDB + S3) inherits AWS baseline. |
| **RTO** | <= 4 hours | Terraform redeploy from code in minutes. |
| **RPO** | <= 5 minutes | DynamoDB PITR (35-day continuous backup). |
| **Performance p50** | <= 150 ms | DynamoDB single-digit ms + warm Lambda. |
| **Performance p95** | <= 400 ms | Single Hono Lambda = one warm container for all routes. |
| **Performance p99** | <= 1,000 ms | Cold-start surface reduced from 9 Lambdas to 1. |
| **PDF generation** | <= 10 s | Async via SQS + `pdf-worker` (1024 MB, 60s timeout). |
| **Report export** | <= 20 s | Async via SQS + `report-worker` (pre-aggregated data). |
| **Dashboard load** | <= 2.5 s on 4G | CloudFront + S3 static assets; SPA route changes <= 800 ms. |
| **Upload** | <= 5 s for <= 10 MB | Direct-to-S3 presigned URLs (bypasses Lambda). |
| **Concurrent users** | <= 100 forever | Serverless scales trivially. |
| **Super Admin sessions** | 1 | DynamoDB session lock. |
| **Storage growth** | <= 50 GB (Y5) | S3 lifecycle: Standard -> IA (90d) -> Glacier (2y). |
| **DynamoDB size** | <= 5 GB | Metadata only; documents in S3. |
| **Data retention** | 10 years | S3 lifecycle + DynamoDB soft-delete. |
| **Security** | TLS 1.3, encryption at rest, Law 09-08 | See section 5. |
| **Cost** | <= $20/month | See section 8. |
| **IaC** | Terraform | See section 6.3. |

**Trade-offs explicitly accepted (from NFR section 7):**

1. DynamoDB requires upfront access-pattern design — no ad-hoc SQL.
2. Twilio WhatsApp is the main cost risk — hard caps enforced.
3. No penetration test at this budget — OWASP ZAP + Dependabot instead.
4. KMS encryption skipped in favor of free AWS-owned keys.
5. Super Admin single-session limit may frustrate if team grows.
6. CloudFront free tier covers this scale; monitor if traffic grows.

---

## 8. Cost Model

### 8.1 Estimated Monthly Cost (at ~100 accounts)

| Service | Estimated Cost | Notes |
|---------|----------------|-------|
| Lambda (4 functions) | ~$0-1 | Pay-per-request; mostly free tier |
| API Gateway (HTTP API) | ~$1 | ~$1/million requests |
| DynamoDB (on-demand, ~5 GB) | ~$2-5 | No idle cost; PITR adds ~$0.20/GB |
| S3 (~50 GB + requests) | ~$1-2 | Lifecycle policies reduce over time |
| CloudFront | $0 | Free tier: 1 TB egress, 10M requests |
| SES (email) | ~$0.50 | ~$0.10/1,000 emails |
| **Twilio (WhatsApp)** | **~$5-10** | **Biggest variable cost** |
| SSM Parameter Store | $0 | Free tier |
| CloudWatch | ~$0-1 | Logs + metrics |
| **Total** | **~$10-20** | Within budget |

### 8.2 Cost Controls

| Control | Implementation |
|---------|----------------|
| Budget alerts | AWS Budgets at 80% ($16) and 100% ($20) |
| Twilio hard cap | Configured in Twilio console |
| Lambda reserved concurrency | Capped at 50 per function |
| Egress monitoring | CloudFront + S3 egress reviewed monthly |
| DynamoDB on-demand | No provisioned capacity to over-provision |
| S3 lifecycle | Automatic transition to IA/Glacier |

### 8.3 Key Cost Risk

**Twilio WhatsApp** is the only line item that can push the budget over $20. Mitigations:

- Hard monthly cap in Twilio console.
- Batch notifications where possible.
- Restrict WhatsApp to critical alerts only (rent overdue, lease expiring).
- Email (SES) as the default channel; WhatsApp as opt-in.

---

## 9. Module Boundaries and Dependency Rules

### 9.1 Module Structure

Each backend module is self-contained:

```
modules/property/
|-- routes.ts        # Hono sub-app — route definitions
|-- service.ts       # Business logic — pure, testable, no AWS SDK calls
|-- repository.ts    # DynamoDB access — all PK/SK logic lives here
|-- validators.ts    # Zod schemas for input validation
|-- types.ts         # Module-specific types
|-- index.ts         # Public API — exports sub-app + service
|-- __tests__/
```

### 9.2 Dependency Rules

| Rule | Enforcement |
|------|-------------|
| Modules cannot import from other modules' `repository.ts` | ESLint `no-restricted-imports` |
| Modules can only import from other modules' `index.ts` (public API) | ESLint rule + code review |
| `shared/` cannot import from `modules/` | ESLint `no-restricted-imports` |
| `lambdas/` can only import from `app.ts` | ESLint |
| No circular dependencies between modules | `dependency-cruiser` in CI |

### 9.3 Cross-Module Communication

- **Synchronous:** Module A imports Module B's `index.ts` and calls its service **in-process**. No Lambda-to-Lambda HTTP calls.
- **Asynchronous:** Module A emits a domain event; Module B consumes it via `shared/events/`.

**Example flow — recording a payment:**

```
1. Frontend -> POST /payments -> api-handler (Hono)
2. Hono route -> payment-service.recordPayment()
3. payment-service -> validates lease exists (in-process call to lease-service)
4. payment-service -> writes Payment item to DynamoDB
5. payment-service -> emits PaymentRecorded event (via DynamoDB Streams)
6. stream-aggregator -> updates SUMMARY#<yyyy-mm> item
7. notification-worker -> sends quittance email/WhatsApp
8. payment-service -> enqueues PDF job to pdf-queue (returns 202 to client)
9. pdf-worker -> generates quittance PDF, uploads to S3
```

---

## 10. Alternatives Considered

### 10.1 Option 2: Serverless Microservices

| Aspect | Assessment |
|--------|------------|
| **Style** | Each domain = independent Lambda + own table/key space; EventBridge for async |
| **Pros** | Independent deployability, fault isolation, future-proof |
| **Cons** | Massive complexity for 100 users; distributed debugging; eventual consistency; **cost likely exceeds $20/month** (EventBridge + X-Ray + multiple Lambdas) |
| **Verdict** | Rejected — over-engineered; cost risk |

### 10.2 Option 3: Containerized Modular Monolith (ECS Fargate)

| Aspect | Assessment |
|--------|------------|
| **Style** | Single Docker image on ECS Fargate; ALB + API Gateway |
| **Pros** | No cold starts; no 15-min limit; easier local dev; full runtime control |
| **Cons** | **Cost-prohibitive** (Fargate + ALB + API Gateway exceeds $20/month); no scale-to-zero; ops burden (container patching, VPC) |
| **Verdict** | Rejected — cost constraint |

### 10.3 Decision Matrix

| Criteria | Option 1 (Serverless Modulith + Hono) | Option 2 (Microservices) | Option 3 (Fargate) |
|----------|---------------------------------------|--------------------------|---------------------|
| **Cost <= $20/month** | Yes ($10-20) | No ($25-40) | No ($20-30) |
| **Team size (1-3)** | Yes | No (needs 4-8) | Partial (needs 2-4) |
| **Time to market** | Fastest | Slowest | Medium |
| **Cold starts** | 1 surface | 9+ surfaces | None |
| **Ops burden** | Lowest | Highest | Medium |
| **NFR fit** | Best | Over-engineered | Cost risk |
| **Complexity** | Medium | High | Medium-High |

**Decision:** Option 1 — Serverless Modular Monolith with a single Hono API Lambda.

---

## 11. Risks and Mitigations

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| 1 | DynamoDB access patterns change post-launch | High | Medium | Design schema upfront; use ADRs; allow for GSI additions |
| 2 | Twilio WhatsApp cost overrun | High | Medium | Hard cap; batch; restrict to critical alerts |
| 3 | Single API Lambda blast radius | Medium | Low | Hono `onError` middleware; comprehensive error handling |
| 4 | Arabic PDF generation fails in Lambda | High | Medium | Test early; use headless Chrome layer; separate PDF service if needed |
| 5 | Team unfamiliar with DynamoDB single-table | High | Medium | Invest in training; hire expert for schema design |
| 6 | Terraform state corruption | High | Low | Versioned S3 bucket; DynamoDB lock; regular backups |
| 7 | AWS region outage (eu-west-1) | High | Low | Daily backups to eu-west-3; RTO <= 4h via Terraform redeploy |
| 8 | Super Admin single-session limit frustrates team | Low | Medium | Revisit if team grows |
| 9 | CloudFront free tier exceeded | Low | Low | Monitor egress; budget alert |
| 10 | No penetration test | Medium | Low | OWASP ZAP + Dependabot in CI |
| 11 | Node.js 20 deprecated on Lambda | High | N/A | Use `nodejs26.x` runtime |

---

## 12. Open Items / Future Considerations

1. **DynamoDB access-pattern rigidity** — if reporting needs grow beyond pre-aggregation, consider DynamoDB Streams -> S3 -> Athena.
2. **Twilio cost** — if WhatsApp usage grows, evaluate alternative providers.
3. **KMS encryption** — revisit if compliance demands customer-managed keys.
4. **Super Admin multi-session** — revisit if internal team grows.
5. **Penetration testing** — schedule annually once budget allows.
6. **Multi-region active-active** — not needed at this scale.
7. **Shared types between frontend/backend** — currently duplicated; migrate to pnpm workspace if team grows.
8. **Staging environment** — currently dev-only; add staging if release cadence increases.
9. **Hono v5 migration** — currently on v4.13+; v5 is in RC. Plan migration when stable.
10. **TypeScript 7 ecosystem** — some tools (webpack loaders, typescript-eslint) may not yet support TS 7; monitor and adopt when ready.

---

## 13. Glossary

| Term | Definition |
|------|------------|
| **ADR** | Architecture Decision Record |
| **ALB** | Application Load Balancer |
| **API Gateway** | AWS managed API service |
| **BRD** | Business Requirements Document |
| **CNDP** | Commission Nationale de controle de la protection des Donnees a caractere Personnel (Moroccan data protection authority) |
| **DLQ** | Dead Letter Queue |
| **DynamoDB** | AWS managed NoSQL database |
| **ECS** | Elastic Container Service |
| **Fargate** | AWS serverless container compute |
| **GSI** | Global Secondary Index |
| **Hono** | Ultrafast web framework for serverless runtimes |
| **IaC** | Infrastructure as Code |
| **JWT** | JSON Web Token |
| **Lambda** | AWS serverless compute |
| **MAD** | Moroccan Dirham |
| **MFA** | Multi-Factor Authentication |
| **Modulith** | Modular Monolith |
| **NFR** | Non-Functional Requirements |
| **OTP** | One-Time Password |
| **PITR** | Point-in-Time Recovery |
| **RPO** | Recovery Point Objective |
| **RTO** | Recovery Time Objective |
| **S3** | AWS Simple Storage Service |
| **SES** | AWS Simple Email Service |
| **SQS** | AWS Simple Queue Service |
| **SSE-S3** | Server-Side Encryption with S3-managed keys |
| **SSM** | AWS Systems Manager |
| **TLS** | Transport Layer Security |
| **TTL** | Time To Live |
| **VPC** | Virtual Private Cloud |

---

## 14. Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Solution Architect | | | |
| Senior Business Analyst | | | |
| Engineering Lead | | | |
| Product Owner | | | |

---

**End of Document**