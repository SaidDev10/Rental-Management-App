output "table_name" {
  description = "DynamoDB table name for the backend TABLE_NAME setting."
  value       = aws_dynamodb_table.main.name
}

output "table_arn" {
  description = "DynamoDB table ARN for IAM policies."
  value       = aws_dynamodb_table.main.arn
}

output "table_stream_arn" {
  description = "DynamoDB stream ARN for the stream aggregator event source."
  value       = aws_dynamodb_table.main.stream_arn
}

output "api_endpoint" {
  description = "Invoke URL for the stage's API Gateway HTTP API."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "api_id" {
  description = "API Gateway HTTP API ID."
  value       = aws_apigatewayv2_api.http.id
}

output "api_handler_function_name" {
  description = "Stage-specific API Lambda function name."
  value       = aws_lambda_function.api["api_handler"].function_name
}

output "api_handler_alias_arn" {
  description = "Rollback-capable live alias ARN for the API Lambda."
  value       = aws_lambda_alias.api_live["api_handler"].arn
}

output "authorizer_function_name" {
  description = "Stage-specific Lambda authorizer function name."
  value       = aws_lambda_function.api["authorizer"].function_name
}

output "authorizer_alias_arn" {
  description = "Rollback-capable live alias ARN for the Lambda authorizer."
  value       = aws_lambda_alias.api_live["authorizer"].arn
}

output "pdf_queue_url" {
  description = "PDF SQS queue URL for API producers and the PDF worker."
  value       = aws_sqs_queue.worker["pdf"].id
}

output "pdf_queue_arn" {
  description = "PDF SQS queue ARN."
  value       = aws_sqs_queue.worker["pdf"].arn
}

output "pdf_dlq_url" {
  description = "PDF dead-letter queue URL."
  value       = aws_sqs_queue.worker_dlq["pdf"].id
}

output "report_queue_url" {
  description = "Report SQS queue URL for API producers and the report worker."
  value       = aws_sqs_queue.worker["report"].id
}

output "report_queue_arn" {
  description = "Report SQS queue ARN."
  value       = aws_sqs_queue.worker["report"].arn
}

output "report_dlq_url" {
  description = "Report dead-letter queue URL."
  value       = aws_sqs_queue.worker_dlq["report"].id
}

output "notification_queue_url" {
  description = "Notification SQS queue URL for producers and the notification worker."
  value       = aws_sqs_queue.worker["notification"].id
}

output "notification_queue_arn" {
  description = "Notification SQS queue ARN."
  value       = aws_sqs_queue.worker["notification"].arn
}

output "notification_dlq_url" {
  description = "Notification dead-letter queue URL."
  value       = aws_sqs_queue.worker_dlq["notification"].id
}

output "stream_dlq_url" {
  description = "DynamoDB stream aggregator failure destination queue URL."
  value       = aws_sqs_queue.stream_dlq.id
}

output "stream_dlq_arn" {
  description = "DynamoDB stream aggregator failure destination queue ARN."
  value       = aws_sqs_queue.stream_dlq.arn
}

output "documents_bucket_name" {
  description = "Documents S3 bucket name consumed by workers."
  value       = var.documents_bucket_name
}

output "documents_bucket_arn" {
  description = "Documents S3 bucket ARN used by worker IAM policies."
  value       = local.documents_bucket_arn
}

output "photos_bucket_name" {
  description = "Existing photos S3 bucket name used by the API Lambda."
  value       = var.photos_bucket_name
}

output "photos_bucket_arn" {
  description = "Existing photos S3 bucket ARN used by the API Lambda IAM policy."
  value       = "arn:aws:s3:::${var.photos_bucket_name}"
}

output "ssm_param_prefix" {
  description = "SSM path prefix configured on worker Lambdas."
  value       = local.ssm_param_prefix
}

output "ses_from_address" {
  description = "SES sender address configured on the notification worker."
  value       = var.ses_from_address
}
