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
