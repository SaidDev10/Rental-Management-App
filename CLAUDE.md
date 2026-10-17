# CLAUDE.md

## Project

**Rental Management App** — a web application for individual property owners in Morocco to manage short/long-term residential rentals. Single-tenant-per-account SaaS: property owners (the only end-user role) manage properties, tenants, leases, rent payments, documents, and maintenance. A Super Admin role handles platform-level operations.

Target scale: `<= 100` concurrent users, `<= 20 USD/month` infrastructure budget, 1–3 person engineering team.

## Stack at a glance

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, TypeScript 7, TanStack Query, Zustand, Tailwind CSS v4, React Router v7 |
| Backend | Hono 4 on a single AWS Lambda (`nodejs26.x`), 5 async workers |
| Data | DynamoDB single-table design, 2 GSIs, DynamoDB Streams |
| Storage | S3 (documents, photos, SPA), CloudFront |
| Async | SQS + DLQs, EventBridge Scheduler |
| Infra | Terraform, AWS `eu-west-1` |
| UI languages | French + English |

## Implementation specifications

Two detailed specifications live alongside this file. **Read the relevant one before writing any code.**

| Document | Covers |
|---|---|
| `.claude/backend.md` | Backend Implementation Specification — API routes, Lambda topology, DynamoDB schema and access patterns, module boundaries, async workers, security, ESLint/TypeScript config, testing, deployment |
| `.claude/frontend.md` | Frontend Implementation Specification — component structure, routing, state management, API client, forms, i18n, styling |

For system-level context (architecture decisions, cost model, alternatives considered), see `Architecture.md` at the repository root.

## Non-negotiable rules

These are enforced by lint, CI, or DynamoDB key design. Breaking them causes real defects, not style complaints.

1. **`accountId` always comes from the verified JWT** — never from a path param, query param, or request body.
2. **Every DynamoDB key is account-scoped**, including GSI keys. A query without an account prefix returns another tenant's data.
3. **No module imports another module's `repository.ts`.** Cross-module calls go through the other module's `index.ts`.
4. **`service.ts` files contain no AWS SDK calls.** All I/O lives in `repository.ts`.
5. **Relative imports carry no file extension.** `from '../property'`, not `from '../property.ts'`.
6. **Named exports only**, except in `src/lambdas/**` and `*.config.*`.
7. **Money is always an integer number of centimes.** No floats anywhere in the money path.
8. **Soft deletes only** for domain entities. A 10-year retention requirement applies to all financial and legal records.

## Commands

```bash
corepack pnpm install    # install dependencies using the pinned pnpm version
corepack pnpm dev        # local API on :3000 (dynamodb-local + localstack)
corepack pnpm typecheck  # tsgo --noEmit
corepack pnpm lint       # eslint . --max-warnings 0
corepack pnpm test       # unit tests
corepack pnpm test:integration
corepack pnpm build
corepack pnpm seed       # populate local fixtures
```

## Conventions

- **Formatting is owned by ESLint**, not Prettier. `eslint --fix` before committing. Do not run Prettier over this repository.
- **Blank line before `return`**, and between declarations, control-flow blocks, and exports. Enforced by `@stylistic/padding-line-between-statements`.
- **Error codes are `SCREAMING_SNAKE`** and stable — they are part of the API contract. See `backend.md` §9.2.
- **Every new endpoint needs an account-isolation test.** Parameterized suite, one entry per route.

## Open items

Corrections C-1 through C-7 in `backend.md` §2 are **blocking** and require Solution Architect ratification before implementation begins. The most significant are C-1 (a fifth Lambda, `notification-worker`, is missing from Architecture v2.0) and C-2 (GSI keys are not account-scoped in the current Architecture draft — a security defect).