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
output "ssm_param_prefix" {
  description = "SSM path prefix configured on worker Lambdas."
  value       = local.ssm_param_prefix
}

output "ses_from_address" {
  description = "SES sender address configured on the notification worker."
  value       = var.ses_from_address
}
