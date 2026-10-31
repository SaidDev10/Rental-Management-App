resource "aws_sns_topic" "alarms" {
  name = "${var.stage}-backend-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  dead_letter_queues = {
    pdf          = aws_sqs_queue.worker_dlq["pdf"].name
    report       = aws_sqs_queue.worker_dlq["report"].name
    notification = aws_sqs_queue.worker_dlq["notification"].name
    stream       = aws_sqs_queue.stream_dlq.name
  }
  lambda_function_names = {
    for key, function in aws_lambda_function.worker : key => function.function_name
  }
  alarm_lambda_names = merge(local.lambda_function_names, {
    stream_aggregator = aws_lambda_function.stream_aggregator.function_name
  })
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  for_each = local.dead_letter_queues

  alarm_name          = "${var.stage}-${each.key}-dlq-depth"
  alarm_description   = "At least one message is awaiting investigation in the ${each.key} dead-letter queue."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    QueueName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.alarm_lambda_names

  alarm_name          = "${var.stage}-${each.key}-lambda-errors"
  alarm_description   = "One or more invocations failed during the five-minute evaluation period."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    FunctionName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_throttles" {
  alarm_name          = "${var.stage}-dynamodb-throttles"
  alarm_description   = "DynamoDB throttled one or more requests to the stage table."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ThrottledRequests"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    TableName = aws_dynamodb_table.main.name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_concurrency" {
  alarm_name          = "${var.stage}-lambda-concurrency"
  alarm_description   = "Account-wide Lambda concurrency is approaching the configured capacity threshold."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ConcurrentExecutions"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.lambda_concurrency_alarm_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}