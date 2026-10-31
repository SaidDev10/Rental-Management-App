# Production deployment, cutover, and incident-response runbook

This runbook describes the controlled release and operational response for the
backend. It is repository-local guidance; it does not authorize or perform an
AWS change. Before any production deployment or Terraform apply, obtain explicit
approval from the service owner and follow the approved change window.

> **Production readiness gate:** The current Terraform module provisions the
> DynamoDB table and background workers/queues, and defines worker/DLQ,
> DynamoDB-throttle, and Lambda-concurrency alarms routed to an SNS topic with
> an optional email subscription. The user reports manually deploying resources
> represented in Terraform state; the supplied state list includes the table,
> workers/stream, queues, SNS topic, alarms, and aliases. This is user-reported
> and has not been independently inspected. The list does not show the API
> Lambda/API Gateway or an SNS email subscription. SNS subscription confirmation
> and end-to-end notification delivery remain unverified. No production
> deployment pipeline or production endpoint is documented here. Do not declare
> a production cutover until P9-T2 gaps are implemented, reviewed, and verified.
> If these prerequisites remain absent, stop at the go/no-go gate and escalate
> to the service owner. Do not infer a production URL, alarm recipient, or
> approval.

## 1. Roles and change record

Before scheduling a change, record in the approved change ticket:

- Change owner, release operator, independent reviewer, on-call contact, and
  decision-maker (include a backup contact and escalation channel).
- Change window, stage/account/region, source commit, artifact checksums, and the
  approved Terraform plan identifier, if applicable.
- The production API base URL and approved synthetic account **only after these
  are provided by the service owner**. Never put credentials, tokens, or customer
  data in this record.
- The previous known-good commit and exact deployable artifacts, and the person
  authorized to approve rollback.
- Smoke-test results, alarm state, incident/ticket link, and explicit handoff
  acceptance at the end of the watch.

Use the least-privileged production identity. Verify the AWS account and region
with the authorized operator before any AWS command. Never copy production
secrets into shell history, chat, logs, or this repository.

## 2. Pre-deployment and go/no-go

1. Confirm a change ticket, owner, independent reviewer, staffed monitoring
   window, and a tested contact/escalation route. Freeze unrelated changes.
2. Confirm P9-T2 has delivered the API deployment path, production alarms and
   notification routing, and an approved deployment/rollback procedure. Confirm
   the alert thresholds and owners are known. **If any is missing, no-go.**
3. Review the release diff and existing CI/local checks. Build the artifacts
   required by the approved release from the recorded commit; for all configured
   artifacts, the repository command is `pnpm run build`. Record artifact hashes
   and retain the prior known-good artifacts outside this change.
4. Review Terraform configuration without applying it:

   ```sh
   terraform -chdir=infra/terraform fmt -check
   terraform -chdir=infra/terraform init -backend-config=backend.prod.hcl
   terraform -chdir=infra/terraform validate
   terraform -chdir=infra/terraform plan -var-file=<approved-production-vars-file> -out=<reviewed-plan-file>
   ```

   `init` and `plan` access the configured production backend/provider; use them
   only from an authorized environment. The production backend is configured for
   the `prod/terraform.tfstate` key in `eu-north-1`. Review the complete plan with
   an independent reviewer, verify the AWS account/stage and artifact paths, and
   stop if it unexpectedly replaces/deletes the production table or other
   persistent data. Do not use `-target` to bypass a failed review. Do not apply
   until explicit approval has been granted for that exact change.
5. The release operator and reviewer announce go/no-go. Keep the approved plan,
   prior artifacts, rollback owner, smoke checklist, and monitoring dashboard or
   alarm view available to the on-call team.

## 3. Deployment and smoke checks

Apply only the exact independently reviewed plan after explicit approval and in
accordance with the approved change window. Record the operator, time, plan, and
result. Do not use this runbook as permission to deploy.

After an approved API deployment, set `BASE_URL` to the production API URL
provided by the service owner; do not guess it. Run the read-only health check:

```sh
curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$BASE_URL/health"
```

Expected: HTTP `200`; when inspecting the response body, it reports `ok: true`
and `service: rental-api`. A transport failure, non-200, malformed response, or
unexpected service identity is a failed smoke test and blocks cutover.

Then, using only an approved synthetic account and authorized read-only
operations:

- Verify sign-in and one authenticated read path; confirm the response belongs
  only to that account and contains no cross-account data. Do not use a real
  customer's account or create/update/delete production records as a smoke test.
- Verify expected security headers and the production origin/cookie behavior
  using the release's approved browser/API checks. Never print tokens or
  credentials.
- Confirm CloudWatch logs show no new startup/configuration errors and review
  the production alarms and service metrics. Record request/error counts and
  latency observations from the approved production telemetry.
- A failed check means stop rollout, notify the incident lead, and follow
  [Rollback](#5-rollback). Do not repeatedly retry a potentially state-changing
  request.

The repository k6 script is deliberately loopback-only and exercises only
`GET /health`; it rejects remote/production targets. Its 100-VU profile and
p95/p99 thresholds are local acceptance checks, **not** a production smoke test
or evidence of production latency. Follow [Local k6 smoke/load check](k6-load-testing.md)
for local use. Any separately approved production load exercise requires its own
controlled test plan and is not authorized by this document.

## 4. Monitoring and alarm response

The currently configured worker log groups use the name pattern
`/aws/lambda/<table-name>-<stage>-<worker-name>` and 30-day retention. With the
Terraform defaults, worker queues have a four-day message retention period and
DLQs have a fourteen-day retention period; workers retry failed messages up to
three receives before redrive. These are configuration facts, not proof that
notifications are delivered. The user reports deploying the alarm resources
listed in Terraform state. Terraform defines alarms for worker and stream
Lambda errors, worker DLQ depth, DynamoDB throttles, and Lambda concurrency,
routed through an SNS topic with an optional email subscription. API Gateway/API
deployment and API-specific alarms are absent from the supplied state list.
Production status is user-reported; subscription confirmation and notification
delivery are unverified. Treat
those gaps as a no-go, not as a green signal.

Once P9-T2 provisions and verifies the configured alarms and notification
delivery, the on-call operator should review at least these signals. Thresholds
and notification destinations for API-specific monitoring must be set by
P9-T2/service owners; this runbook does not invent them:

| Signal | Initial response |
| --- | --- |
| API availability, 5xx/errors, throttles, and request latency | Check the health smoke, deployment/change timeline, API/Lambda logs and upstream dependency health. Freeze rollout; compare with the pre-change baseline. |
| Worker Lambda errors, throttles, duration/timeouts | Identify function and request/job IDs in its CloudWatch log group; inspect config, recent artifact, and dependency errors. Check whether queues are accumulating. |
| SQS oldest-message age / visible backlog and any worker DLQ depth | Identify the affected queue and message/job IDs without exposing payload secrets. Stop adding work if safe; do not purge or redrive a queue until the owner assesses duplicate side effects and approves a recovery. |
| DynamoDB throttles and stream-aggregator iterator age/failure destination | Check capacity/throttle metrics and stream logs/DLQ. Preserve failed-record context; do not delete, replay, or alter stream/queue data without an approved recovery plan. |
| Authentication, authorization, account-isolation, or security-header regression | Treat as a security incident: stop cutover, restrict exposure using the approved incident procedure, preserve relevant audit/log evidence, and notify the security/service owner immediately. |

For every alarm: acknowledge it in the configured on-call channel, assign one
incident lead and one technical operator, timestamp the event, record affected
stage/resources and customer impact, and open/link an incident record. Check
whether the alert is actionable or a telemetry fault; do not silence or delete
an alarm to clear the page. If customer data/security may be affected, follow
security/privacy escalation requirements and limit access to the incident
record. Give periodic status updates through the agreed channel until recovery
is confirmed and the incident lead closes the incident.

## 5. Rollback

Rollback triggers include a failed smoke check, a newly firing release-related
critical alarm, sustained error/latency regression against the approved gate,
worker backlog/DLQ growth that risks job completion, or any security or
account-isolation regression. The incident lead may stop the rollout; any
production change used to restore service still requires the designated
approval.

1. Declare/record the incident, notify the on-call/service owner, stop further
   rollout and unrelated changes, and capture the deployed commit/artifact
   hashes, plan, alarm state, and relevant logs/metrics. Do not discard evidence.
2. For code/artifact rollback, restore the exact previously recorded known-good
   source and artifacts. Review a new plan/change against the production state;
   rollback is a new production change, not an informal state edit.
3. Apply the rollback only after explicit approval for that rollback plan. For
   Terraform-managed resources use the normal production backend, independent
   plan review, and approved apply procedure. Re-run the health and read-only
   smoke checks, inspect alarms/queues, and keep the incident watch active until
   the incident lead confirms recovery.
4. Do **not** use `terraform destroy`, manually delete production resources,
   `terraform state rm`, purge queues/DLQs, or assume reverting code reverses
   data/schema changes. DynamoDB point-in-time recovery and prod deletion
   protection are not a substitute for a reviewed data-recovery plan. If data
   corruption or an incompatible migration is suspected, stop and escalate for
   a separate backup/restore or forward-fix decision; preserve evidence.
5. Record outcome, user impact, unresolved work, and follow-up owner in the
   incident/change record. Schedule a post-incident review for material impact.

## 6. Monitoring handoff and closeout

At the end of the approved watch window, the release operator hands off to the
named on-call owner: change/incident link; exact deployed commit and artifact
hashes; stage/account/region; smoke results; alarm/dashboard links and any
thresholds; current errors, latency, queue age/backlog/DLQ state; actions taken;
rollback decision/owner; and the next review time. The receiving owner confirms
acceptance in the agreed channel. Keep monitoring and escalation ownership
explicit until that acknowledgement; do not close the change solely because the
smoke check passed. Attach sanitized evidence and list remaining risks/tasks.

## Current limitations and completion gate

This runbook is written against the repository configuration inspected for P9-T3.
It is not an exercise report: no production endpoint, alarms, alarm destination,
API deployment resource, or complete production rollout mechanism is present in
the inspected Terraform/docs. P9-T2 must add and independently verify those
prerequisites. A real operational exercise, production smoke test, alarm drill,
rollback, or cutover remains blocked until the service owner supplies the
production details and separately authorizes the required actions. No AWS
mutation or deployment was performed while writing this document.
