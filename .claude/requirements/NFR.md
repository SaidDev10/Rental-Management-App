# Non-Functional Requirements (NFR)
## Rental Management App

**Version:** 2.1
**Status:** Draft
**Companion document to:** BRD v1.1
**Prepared by:** Senior Business Analyst
**Date:** [Insert date]

**Key constraints applied:**
- ≤ 100 concurrent users forever
- 1 Super Admin concurrent session
- DynamoDB (cheapest managed database)
- ≤ $20/month infrastructure budget, forever
- Terraform for Infrastructure as Code (IaC)
- Single Hono API Lambda (all synchronous routes)
- Node.js 26 LTS runtime (`nodejs26.x`)

---

## 1. Availability

| Requirement | Target | Reasoning |
|---|---|---|
| Monthly uptime SLA | **99.5%** | Serverless (Lambda + DynamoDB + S3) inherits AWS's high baseline availability. 99.5% is realistic at near-zero cost, without paying for Multi-AZ or redundant compute. |
| Max downtime/month | **~3h 36m** | Derived from 99.5%. |
| Planned maintenance | **None required** — serverless, no servers to patch | A major cost and ops saving. |
| RTO (Recovery Time Objective) | **≤ 4 hours** | Terraform + serverless means full redeploy from code in minutes if needed. |
| RPO (Recovery Point Objective) | **≤ 5 minutes** | DynamoDB Point-in-Time Recovery (PITR) gives continuous backup to the second (35-day window) at low cost — better than a traditional daily-backup approach. |

> **Note:** Serverless architecture makes "maintenance windows" largely obsolete. The 99.5% target is a floor, not a stretch.

---

## 2. Performance

### 2.1 API Response Time

| Metric | Target | Reasoning |
|---|---|---|
| **p50** | **≤ 150 ms** | DynamoDB single-digit-ms reads + warm Lambda (single Hono app serves all routes). |
| **p95** | **≤ 400 ms** | Covers advanced filtering queries (DynamoDB GSIs) and list operations. Single warm container serves all sync routes. |
| **p99** | **≤ 1,000 ms (1s)** | Tail latency, excluding async jobs. Cold-start surface reduced to 1 Lambda. |
| **Cold start** | **≤ 1,000 ms** | Mitigated via provisioned concurrency on the API Lambda if needed (cost trade-off — see §5). |

**Async jobs (not counted against API targets):**

- PDF generation (lease, quittance, fiche de police, état des lieux): **≤ 10 s** end-to-end.
- Report exports (Excel/PDF): **≤ 20 s** for a full 100-property portfolio (data volume is far lower than originally assumed).

### 2.2 Page Load Time

| Metric | Target | Reasoning |
|---|---|---|
| Dashboard initial load | **≤ 2.5 s** on 4G | Static assets via CloudFront + S3. |
| SPA route change | **≤ 800 ms** | App is a responsive web app; users expect near-instant transitions between properties/leases. |
| LCP (Largest Contentful Paint) | **≤ 2.5 s** | Core Web Vitals "Good" threshold. |
| TTI (Time to Interactive) | **≤ 3.5 s** | Acceptable on mid-range Android devices common in Morocco. |
| Document/photo upload | **≤ 5 s for files ≤ 10 MB** | Direct-to-S3 upload via presigned URLs (bypasses Lambda). |

---

## 3. Scalability

### 3.1 Concurrent Users

| Metric | Target | Reasoning |
|---|---|---|
| **Concurrent users** | **≤ 100, forever** | Hard ceiling. Serverless handles this trivially — **a single Hono Lambda handles all synchronous routes**. |
| **Super Admin concurrent sessions** | **1** | Hard limit. Only one Super Admin session at a time — simplifies audit logging and prevents conflicting admin actions. |
| Registered owner accounts | **No fixed cap** — bounded by infra budget and provisioning pace | Manual provisioning by Super Admin naturally caps growth. |

### 3.2 Peak Load Scenarios

| Scenario | Trigger | Expected Load |
|---|---|---|
| Month-end rent cycle | Days 1–5, 28–31 | ~100 concurrent users, ~50 PDF jobs/hour |
| Lease renewal season | Aug–Sep, Jan | Moderate read spike |
| Tax season | Feb–Apr | Report export spike |

Even at peak, 100 concurrent users is well within DynamoDB + Lambda + S3 free/low-cost thresholds.

### 3.3 Data Growth Rate

| Metric | Target | Reasoning |
|---|---|---|
| Properties per account | **≤ 100** (per BRD) | Bounded by business rule. |
| Total properties (realistic) | **≤ 10,000** | Modest, aligned with a curated, manually provisioned user base. |
| Leases per property/year | **1–2** | Max 1-year leases. |
| Documents per account/year | **~200–500** | ~1 quittance/month/property + contracts + invoices. |
| **Total storage (Year 1)** | **≤ 10 GB** | |
| **Total storage (Year 5)** | **≤ 50 GB** | Fits easily in S3 Standard. |
| **DynamoDB table size** | **≤ 5 GB** | Metadata only; documents in S3. |
| **Data retention** | **10 years** (per BRD) | S3 lifecycle policy: Standard → IA after 90 days → Glacier after 2 years. |

### 3.4 Database Choice: DynamoDB

| Requirement | Target | Reasoning |
|---|---|---|
| **Database** | **Amazon DynamoDB (on-demand capacity)** | Cheapest serverless option; no idle cost; scales to zero. |
| Access pattern | **Single-table design** with GSIs for: properties-by-account, leases-by-property, payments-by-lease, documents-by-account | DynamoDB requires knowing access patterns upfront — design accordingly. |
| Consistency | **Eventually consistent reads by default** (cheaper); strong consistency only where required (e.g., payment status changes) | Cost optimization. |
| Backups | **PITR enabled** (35-day continuous) + **on-demand backups before schema migrations** | Low cost, high safety. |
| Encryption | **AWS-owned key (default)** — no extra cost. Upgrade to KMS if compliance requires. | Cheapest compliant option. |

> **Trade-off to accept:** DynamoDB sacrifices ad-hoc querying and relational joins. Report generation (income, expenses, yield, occupancy, tax summary) must be pre-aggregated or computed via GSIs/streams. This is a design constraint, not a blocker at this scale.

---

## 4. Security

### 4.1 Authentication

| Requirement | Target | Reasoning |
|---|---|---|
| Primary auth | **Email + password** | Per BRD. |
| Password policy | **Min 12 chars, complexity check, breach-list check (HaveIBeenPwned API — free)** | Stronger than typical minimum; low cost to implement. |
| Password storage | **Argon2id** (fallback: bcrypt cost ≥ 12) | Industry standard; resistant to offline cracking. |
| MFA | **Email OTP** (per BRD) | Simpler and cheaper than SMS; via AWS SES at near-zero cost. |
| Social login | **Google OAuth 2.0** | Per BRD. |
| Session management | **JWT with short-lived access token (≤ 15 min) + refresh token (≤ 30 days), rotated** | Limits blast radius of token theft. |
| Account lockout | **5 failed attempts → 15-min lockout** | Standard brute-force mitigation. |
| **Super Admin session** | **Single concurrent session only**; read-only impersonation, time-boxed (≤ 30 min), fully audit-logged | Enforced via DynamoDB session table with a single-session lock. |

### 4.2 Authorization

| Requirement | Target | Reasoning |
|---|---|---|
| Model | **Account-scoped isolation** (every item keyed by `account_id`) | Native fit for DynamoDB single-table design. |
| Super Admin | **Separate route namespace** (`/admin/*`) with role-guard middleware | Reduces attack surface. |
| API authorization | **Every endpoint enforces ownership check** — no IDOR vulnerabilities | Standard OWASP API Top 10 requirement. |
| Impersonation | **Read-only, no write endpoints accessible**, audit-logged | Explicitly stated in BRD. |

### 4.3 Data Encryption

| Requirement | Target | Reasoning |
|---|---|---|
| In transit | **TLS 1.2+ (prefer TLS 1.3)**, HSTS enabled | Baseline for any web app handling personal + financial data. |
| At rest — DynamoDB | **AWS-owned key (default encryption)** | Free; upgrade to KMS (~$1/key/month) only if required. |
| At rest — S3 | **SSE-S3** | Free. |
| At rest — backups | **Encrypted backups** | Same standard as primary data. |
| Sensitive fields (CIN/passport) | **Application-level encryption** before storing in DynamoDB | Cheap to implement; protects against DB dumps. |
| Key management | **AWS SSM Parameter Store (free tier)** | Prefer over Secrets Manager to stay within budget. |

### 4.4 Compliance

| Requirement | Target | Reasoning |
|---|---|---|
| **Moroccan Law 09-08** (personal data protection) | **Compliant** — CNDP registration, privacy policy, data subject access | Mandatory for any app processing Moroccan residents' personal data. |
| GDPR | **Not legally required** (Morocco, not EU) — but adopt GDPR-aligned practices (data minimization, right to access, breach notification) | Good practice; cheap to align; future-proofs. |
| Data residency | **Store data in AWS eu-west-1 (Ireland)** | Per BRD. |
| Audit logging | **All Super Admin actions logged, retained 10 years** | Aligns with BRD retention rule and internal accountability. |
| Data retention | **10 years** — enforced via automated policies | Per BRD. |
| Backup encryption + offsite | **Daily encrypted backups, stored in a separate AWS region** | Standard DR practice. |

### 4.5 Application Security

| Requirement | Target | Reasoning |
|---|---|---|
| OWASP Top 10 | **Mitigated** — input validation, parameterized queries, CSP, CSRF tokens | Baseline. |
| Dependency scanning | **Dependabot (free on GitHub)** | Free; prevents supply-chain issues. |
| File upload validation | **MIME type + size + S3 bucket blocks public access** | Documents are user-uploaded; must not be publicly accessible. |
| Rate limiting | **API Gateway throttling (built-in, free)** | Mitigates brute force and abuse. |
| Penetration test | **Deferred** (cost-prohibitive at $20/month budget) — rely on automated scanning (OWASP ZAP free tier) | Explicit trade-off. |

---

## 5. Cost

### 5.1 Infrastructure Budget Constraints

| Requirement | Target | Reasoning |
|---|---|---|
| **Infrastructure budget** | **≤ $20 USD/month, forever** | Achievable with serverless + DynamoDB on-demand + S3 + CloudFront free tier. |
| Cost per account | **≤ $0.20/account/month at 100 accounts** | Sanity check on unit economics. |
| Budget alerts | **AWS Budgets at 80% and 100% ($16 and $20)** | Prevents overruns. |
| Egress monitoring | **CloudFront + S3 egress reviewed monthly** | Most common hidden cost. |
| Twilio usage cap | **Hard monthly cap configured in Twilio console** | WhatsApp is the most likely cost overrun. |
| Auto-scaling cap | **Lambda reserved concurrency capped** (e.g., 50 per function) | Prevents cost spikes. |

### 5.2 Hosting Preferences

| Requirement | Target | Reasoning |
|---|---|---|
| **Cloud provider** | **AWS** | Per BRD (SES, S3). |
| **Primary region** | **eu-west-1 (Ireland)** | Cheapest EU region; good latency to Morocco (~50–60 ms). |
| **API Framework** | **Hono v4.13+** with **@hono/aws-lambda v1.0+** adapter | Ultrafast, tiny (~14KB), zero dependencies; first-class Lambda support. |
| **Lambda Runtime** | **`nodejs26.x`** (Node.js 26 LTS) | Node 20 deprecated Apr 2026; Node 26 is Active LTS from Oct 28, 2026. |
| **Compute** | **AWS Lambda (serverless)** — 4 functions: 1 API + 3 workers | Pay-per-request; scales to zero; near-free at this volume. |
| **API layer** | **API Gateway (HTTP API — cheaper than REST API)** | ~$1/million requests. Single catch-all route `ANY /{proxy+}`. |
| **Database** | **DynamoDB (on-demand)** | Cheapest managed DB; no idle cost. |
| **Storage** | **S3 + lifecycle policies** (Standard → IA after 90 days → Glacier after 2 years) | Aligns with 10-year retention; reduces storage cost over time. |
| **CDN** | **CloudFront (free tier: 1 TB egress/month, 10M requests/month)** | Covers this scale entirely. |
| **Email** | **AWS SES** (~$0.10/1,000 emails) | Per BRD. |
| **WhatsApp** | **Twilio** — monitor closely; template messages cost ~$0.005–$0.05 each | **Biggest variable cost.** Consider batching or limiting to critical reminders. |
| **Monitoring** | **CloudWatch (free tier)** + **Sentry free tier** | |
| **CI/CD** | **GitHub Actions (free tier)** | |
| **IaC** | **Terraform** — state stored in **S3 + DynamoDB lock table** | Standard, cheap, version-controlled. |

### 5.3 Estimated Monthly Cost Breakdown (at ~100 accounts)

| Service | Estimated Cost |
|---|---|
| Lambda (4 functions) | ~$0–1 |
| API Gateway (HTTP API) | ~$1 |
| DynamoDB (on-demand, ~5 GB) | ~$2–5 |
| S3 (~50 GB + requests) | ~$1–2 |
| CloudFront (free tier) | $0 |
| SES (email) | ~$0.50 |
| **Twilio (WhatsApp)** | **~$5–10 (variable — biggest cost)** |
| SSM Parameter Store | $0 |
| CloudWatch | ~$0–1 |
| **Total** | **~$10–20** |

> **Key risk:** Twilio WhatsApp is the only line item that can push the budget over $20. Mitigation: hard cap, batch notifications, or restrict WhatsApp to critical alerts only (rent overdue, lease expiring).

---

## 6. Summary Table

| Category | Key Target |
|---|---|
| **Availability** | 99.5% uptime; RTO ≤ 4h; RPO ≤ 5 min (DynamoDB PITR) |
| **Performance** | p50 ≤ 150 ms; p95 ≤ 400 ms; p99 ≤ 1s; LCP ≤ 2.5s; single warm container serves all sync routes |
| **Scalability** | ≤ 100 concurrent users forever; 1 Super Admin session; 1 API Lambda (Hono) + 3 async workers; ≤ 50 GB storage (Y5) |
| **Database** | DynamoDB (on-demand, single-table design, PITR enabled) |
| **Security** | Email/password + Email OTP + Google OAuth; TLS 1.3; SSE-S3 + DynamoDB default encryption; Law 09-08 compliant |
| **Cost** | ≤ $20/month forever; AWS eu-west-1; serverless-first; Terraform IaC |
| **IaC** | Terraform (S3 + DynamoDB state backend) |
| **Runtime** | Node.js 26 LTS (`nodejs26.x`) |
| **API Framework** | Hono v4.13+ with @hono/aws-lambda adapter |

---

## 7. Open Items / Trade-offs to Accept

1. **DynamoDB requires upfront access-pattern design** — no ad-hoc SQL queries. Reporting must be pre-computed (via DynamoDB Streams → aggregation tables, or on-demand Lambda jobs).
2. **Twilio WhatsApp is the main cost risk** — enforce hard caps.
3. **No penetration test** at this budget — compensate with automated scanning (OWASP ZAP, Dependabot).
4. **KMS encryption skipped** in favor of free AWS-owned keys — acceptable for now, revisit if compliance demands it.
5. **Super Admin single-session limit** may frustrate if the team grows — revisit then.
6. **CloudFront free tier** covers this scale; monitor if traffic grows unexpectedly.
7. **Single API Lambda blast radius** — a bug in one module can affect the whole API. Mitigated by Hono's `onError` middleware and comprehensive error handling.
8. **Hono v5 migration** — currently on v4.13+; v5 is in RC. Plan migration when stable.
9. **TypeScript 7 ecosystem** — some tools (webpack loaders, typescript-eslint) may not yet support TS 7; monitor and adopt when ready.

---

**End of Document**