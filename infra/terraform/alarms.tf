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
    api_handler       = aws_lambda_function.api["api_handler"].function_name
    authorizer        = aws_lambda_function.api["authorizer"].function_name
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

resource "aws_cloudwatch_metric_alarm" "api_gateway_5xx" {
  alarm_name          = "${var.stage}-api-gateway-5xx"
  alarm_description   = "The HTTP API returned one or more server errors in the five-minute evaluation period."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "5xx"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    ApiId = aws_apigatewayv2_api.http.id
    Stage = aws_apigatewayv2_stage.default.name
  }
}

resource "aws_cloudwatch_metric_alarm" "api_integration_latency" {
  alarm_name          = "${var.stage}-api-integration-latency-p99"
  alarm_description   = "The HTTP API Lambda integration p99 latency reached one second."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  extended_statistic  = "p99"
  metric_name         = "IntegrationLatency"
  namespace           = "AWS/ApiGateway"
  period              = 300
  threshold           = 1000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    ApiId = aws_apigatewayv2_api.http.id
    Stage = aws_apigatewayv2_stage.default.name
  }
}