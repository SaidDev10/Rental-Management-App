# Business Requirements Document (BRD)
## Rental Management App

**Version:** 1.1
**Status:** Draft
**Prepared by:** Senior Business Analyst
**Date:** [Insert date]

---

## 1. Executive Summary

The Rental Management App is a web-based application for **individual property owners in Morocco** to manage their long-term rental properties in one place. It replaces scattered spreadsheets and manual tracking with a centralized system for properties, tenants, leases, payments, documents, maintenance, and financial reporting.

The application is inspired by existing Moroccan rental management platforms (Aqarrati, Kiraty) but is deliberately scoped to **single-owner accounts** — no agencies, no teams, no tenant logins.

Accounts are **manually provisioned by a Super Admin**. There are no subscriptions, no free plans, and no self-service signup for paid features.

---

## 2. Scope

### 2.1 In Scope

- Single-owner account management (one user per account)
- Property portfolio management (up to 100 properties per account)
- Tenant database
- Lease lifecycle management (max 1-year leases)
- Rent and payment tracking (manual)
- Document generation and storage (lease, quittance, fiche de police, état des lieux, invoices)
- Maintenance ticket system
- Financial reporting and tax summary
- Email and WhatsApp notifications
- Responsive web application (desktop, tablet, mobile browser)
- Super Admin back-office

### 2.2 Out of Scope

- Multi-user accounts, teams, or role-based permissions for end users
- Agency / multi-owner management
- Tenant self-service portal
- Short-term / seasonal rental management (Airbnb, Booking, channel manager)
- Online payment processing
- Bank integration or reconciliation
- SMS notifications
- E-signature
- Calendar sync
- Accounting software integrations
- Third-party listing APIs

---

## 3. User Roles and Permissions

### 3.1 Property Owner (Primary User)

- **Type:** Individual landlord
- **Account model:** One user per account; single isolated workspace
- **Permissions:** Full access to their own data — properties, tenants, leases, payments, documents, maintenance, reports
- **No roles or sub-permissions** within the account (single-user model)
- **Authentication:**
  - Email + password
  - Multi-Factor Authentication via Email OTP
  - Social login via Google
- **Account deletion:** User can request deletion → **soft-delete only** (account disabled, all data retained for 10 years)

### 3.2 Super Admin (Internal Team)

- **Type:** Platform operator (internal)
- **Provisioning:** Manually creates and provisions owner accounts
- **Permissions:**
  - View all user data
  - Impersonate accounts in **read-only mode** (no write access)
  - Delete files/documents
  - Manage account provisioning
- **Sub-roles:** None — single admin level

### 3.3 Non-Users

The following are **not** system users:

- Tenants (no login, no portal)
- Service providers / vendors (tracked as records only, not users)
- Agency staff

---

## 4. Core Features and Workflows

### 4.1 Property Management

**Property types:**

- Apartment
- House
- Commercial space

**Attributes per property:**

- Address
- Surface area
- Number of rooms
- Photos (multiple)
- Purchase value

**Limits:**

- Maximum **100 properties** per account

---

### 4.2 Tenant Management

- Dedicated **tenant database** per account
- Tenant records include contact info, CIN/passport, etc.
- Tenants are reusable — can be attached to multiple leases over time

---

### 4.3 Lease / Contract Lifecycle

**Stages:**

- Draft → Active → Renewed → Terminated

**Rules:**

- One property can have **multiple active leases simultaneously** (e.g., commercial space split across tenants)
- **Maximum lease duration: 1 year**
- Leases **can be edited after activation**
- **PDF generation** from official templates
- **Renewal tracking** with reminders

**Generated PDFs:**

- Lease contract
- Quittance
- Fiche de police
- État des lieux
- **Arabic support required** in generated documents

---

### 4.4 Rent & Payment Tracking

**Recording:**

- Owner records payments manually (cash, bank transfer, check)
- **No online payment gateway**
- **No bank integration**

**Statuses:**

- Due
- Paid
- Late (**5-day grace period** after due date)
- Partial (remains "partial" until fully paid)

**Rules:**

- Currency: **MAD only**
- Rent amounts **editable after lease creation**
- **Partial payments** supported

**Outputs:**

- Auto-generated **quittance PDFs**
- **Auto-numbered sequentially per owner** (legal requirement)

**Reminders:**

- Payment reminders to owner

---

### 4.5 Documents

**Types:**

- Lease contracts
- Quittances
- Fiche de police
- État des lieux
- Invoices (utilities, repairs)

**Rules:**

- Documents can be **uploaded, generated, and downloaded**
- Documents can only be **archived** by the owner (not deleted)
- **Only Super Admin** can delete files
- Stored in **AWS S3**

---

### 4.6 Maintenance / Incidents

**Full ticket system:**

- Log issue
- Assign vendor
- Track status
- Record cost
- Maintain full history

---

### 4.7 Financial Reporting

**Reports:**

- Rental income per property
- Expenses per property
- Net yield / profitability
- Occupancy rate
- **Tax summary report** (owner provides it to their accountant — no auto tax calculation)

**Export:**

- Excel
- PDF

---

### 4.8 Notifications

**Channels:**

- Email (AWS SES)
- WhatsApp (Twilio, template-based)

**Triggers:**

- Rent due
- Late payment
- Lease renewal
- Maintenance follow-ups

**Primary use case:** Reminders to **owners** about unpaid rent.

---

### 4.9 Dashboard

- Similar to Aqarrati's dashboard
- At-a-glance view of:
  - Revenue
  - Occupancy
  - Recent payments
  - Portfolio overview

---

### 4.10 Search & Filtering

- **Advanced filtering** by:
  - Property
  - Tenant
  - Payment status
  - Date range
  - (and other relevant fields)

---

### 4.11 Mobile

- **Web only**
- **Responsive** across desktop, tablet, and mobile browser

---

## 5. Business Rules and Constraints

| # | Rule |
|---|------|
| 1 | No subscriptions, no free plan. Accounts are **manually provisioned by Super Admin**. |
| 2 | Maximum **100 properties** per account. |
| 3 | One property can have **multiple active leases** simultaneously. |
| 4 | **Maximum lease duration: 1 year.** |
| 5 | Leases **can be edited after activation**. |
| 6 | Currency: **MAD only**. |
| 7 | Rent amounts **editable after lease creation**. |
| 8 | **Late** = 5-day grace period after due date. |
| 9 | Partial payments remain **"partial"** until fully paid. |
| 10 | Quittances are **auto-numbered sequentially per owner**. |
| 11 | Documents are **archived, not deleted** by owners. Only **Super Admin** can delete files. |
| 12 | Tax: **summary report only** — no auto-calculation. |
| 13 | **Data retention: 10 years.** |
| 14 | Languages: **French + English** (UI). **Arabic required in generated PDFs.** |
| 15 | Account deletion: **soft-delete only** — account disabled, data retained. |
| 16 | KYC / identity verification: **not required**. |
| 17 | Super Admin impersonation is **read-only** (no write access). |
| 18 | No sub-roles in Super Admin — single admin level. |

---

## 6. Integration Requirements

| Integration | Solution | Notes |
|-------------|----------|-------|
| API framework | **Hono v4.13+** | Web framework running in AWS Lambda |
| Lambda adapter | **@hono/aws-lambda v1.0+** | Separate package since Hono v4.13 |
| WhatsApp notifications | **Twilio** | Template-based messages; primarily owner reminders for unpaid rent |
| Email | **AWS SES** | Transactional emails |
| Payment gateway | **None** | Manual recording only |
| Social login | **Google** | Only provider |
| MFA | **Email OTP** | |
| SMS | **None** | WhatsApp sufficient |
| Bank integration | **None** | |
| Accounting software | **None** | |
| PDF generation | Official Moroccan templates | Arabic support required |
| E-signature | **None** | |
| Cloud storage | **AWS S3** | Documents and photos |
| Analytics | **Google Analytics** | |
| Hosting | Cheapest option — **AWS Ireland (eu-west-1)** | |
| Calendar integration | **None** | |
| Third-party APIs | **None** | |

---

## 7. Assumptions

1. All users are based in Morocco; single-country, single-currency (MAD), single legal framework.
2. Owners are responsible for their own tax filing; the app only provides a summary report.
3. Tenants never log in — all tenant-related data is managed by the owner.
4. Super Admin provisioning is a manual, internal process.
5. Arabic is required only in generated PDF documents, not in the UI.
6. AWS Ireland is assumed as the hosting region pending final cost analysis.
7. The backend uses a **single Hono application** deployed to **one Lambda function** for all synchronous API routes. Async workers (PDF generation, report export, stream aggregation) remain separate Lambda functions.

---

## 8. Glossary

| Term | Definition |
|------|------------|
| **Quittance** | Rent receipt issued to the tenant |
| **Fiche de police** | Moroccan tenant declaration form required by authorities |
| **État des lieux** | Move-in / move-out inspection report |
| **MAD** | Moroccan Dirham |
| **MFA** | Multi-Factor Authentication |
| **OTP** | One-Time Password |
| **Soft delete** | Account disabled but data retained |
| **Super Admin** | Internal platform operator role |
| **Hono** | Ultrafast web framework for serverless runtimes |

---

**End of Document**