# Terraform production deployment and rollback

This module manages the stage DynamoDB table, API and authorizer Lambdas, API Gateway HTTP API, asynchronous worker Lambdas/queues, stream aggregator, and alarms. All Lambda functions use the AWS `nodejs26.x` runtime to match the backend specification. The API Lambda artifact includes the Linux x86_64 glibc Argon2 native binding; build dependencies with pnpm's supported Linux architecture enabled and verify the binding is present before deployment. It publishes the API Lambda artifacts as content-hashed S3 objects and uses `live` aliases for API Gateway invocation. `allowed_origins` is required and must list the exact browser origins for the target stage; for dev without a deployed frontend, use the local development origin only if needed. The photos and documents buckets default to the same existing `rental-management-documents` bucket and use separate object-key prefixes; `lambda_artifacts_bucket_name` defaults to `rental-management-artifacts`. Both must exist before deployment. The initialized dev backend is configured for `eu-north-1`, matching the user-confirmed target; do not switch an existing state to another region. Production uses the separate S3 backend in `backend.prod.hcl`; never initialize production against the local/dev state. The state bucket and alarm recipient must be provisioned/verified by the account owner. Production requires `alarm_email`; confirm the SNS subscription from its email before relying on notifications.

## Safe production release

1. Build and verify all Lambda artifacts from the release commit at the repository root:

   `pnpm build`

2. Confirm `dist/api-handler.zip`, `dist/authorizer.zip`, `dist/pdf-worker.zip`, `dist/report-worker.zip`, `dist/notification-worker.zip`, and `dist/stream-aggregator.zip` exist. Preserve these files with the release record; each uploaded object key includes a content hash. Terraform manages only the active artifact object and removes the previous S3 key during a release update, so the prior ZIP must be retained in the release archive for rollback.
3. From `infra/terraform`, initialize the production backend and generate a saved plan using the production notification address:

   `terraform init -reconfigure -backend-config=backend.prod.hcl`

   `terraform plan -var='stage=prod' -var='alarm_email=on-call@example.com' -var='allowed_origins=["https://app.rental-app.ma"]' -out=prod.tfplan`

4. Review the saved plan for intended resources, state/account/region (`eu-north-1`), destructive changes, DynamoDB retention/protection, immutable artifact keys, alarms and SNS action. Stop and investigate unexpected replacement/deletion, account mismatch, or missing build output. Never apply an unreviewed or stale plan.
5. After explicit deployment approval, apply only the reviewed saved plan with `terraform apply prod.tfplan`. Do not run `terraform apply` without a saved, reviewed plan. Confirm the SNS email subscription, alarm state, Lambda `live` aliases, event source mappings, and a production health/smoke check authorized for that release. Record plan, artifact hashes, approver, outcome, and alarm confirmation in the release log. Remove the local plan file securely after use; it may contain sensitive state values.

The plan and apply commands above are operational instructions only; no AWS plan, apply, mutation, or deployment is run as part of local verification. Obtain explicit approval before any AWS action.

## Rollback

For an application rollback, restore the exact prior release ZIPs from the release archive and use those artifact paths; Terraform re-uploads them under their original content-hash keys. Generate and review a new production plan. After explicit approval, apply the reviewed plan; Terraform publishes the restored code as a new Lambda version and moves each `live` alias, which is the target of API Gateway and SQS/stream event sources. Previously published Lambda versions remain available; the old S3 key may have been removed during the forward release, so do not rely on it being present. This rollback avoids changing queue data. Verify API routes/authorizer, aliases, mappings, queue age/DLQs, and alarm notifications after rollback. Never delete or purge DLQ messages as part of rollback; inspect and replay only through the approved recovery procedure.

For infrastructure/state recovery, preserve the current state and obtain incident-owner approval before restoring a prior state snapshot or running `terraform state` operations. DynamoDB is protected from Terraform deletion in prod and has PITR enabled; a table restore requires a separate data-recovery decision and validation. The specification targets RPO <= 5 minutes and RTO <= 4 hours; this repository does not yet include a completed restore drill or automated state backup verification.

## Scope and known gaps

CloudWatch alarms cover the four DLQs, API/worker/stream Lambda invocation errors, API Gateway 5xx responses and p99 integration latency, active-stage DynamoDB throttles, and account-wide Lambda concurrency. The API endpoint and API/authorizer Lambda names and live API alias are exposed as Terraform outputs. AWS Budgets/SNS budget notifications and alarm delivery require account-level confirmation. No production resources are claimed as provisioned until an approved apply and live verification are completed.

## Local verification (no AWS mutation)

From the repository root, run `terraform fmt -check infra/terraform`, `terraform -chdir=infra/terraform init -backend=false`, `terraform -chdir=infra/terraform validate`, and `terraform -chdir=infra/terraform test`. These validate configuration and mocked assertions only; they do not prove deployed production state.