mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-worker"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:eu-north-1:123456789012:mock-alarms"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:eu-north-1:123456789012:mock-queue"
    }
  }
}

run "worker_queue_and_mapping_configuration" {
  command = apply

  variables {
    stage = "dev"
  }

  assert {
    condition = alltrue([
      for key in keys(local.worker_queue_settings) :
      aws_sqs_queue.worker[key].visibility_timeout_seconds >= (
        aws_lambda_function.worker[key].timeout * 6 +
        aws_lambda_event_source_mapping.worker[key].maximum_batching_window_in_seconds
      )
    ])
    error_message = "Each SQS visibility timeout must cover six Lambda timeouts plus the batching window."
  }

  assert {
    condition = alltrue([
      for key in keys(local.worker_queue_settings) :
      aws_lambda_event_source_mapping.worker[key].event_source_arn == aws_sqs_queue.worker[key].arn &&
      aws_lambda_event_source_mapping.worker[key].function_name == aws_lambda_alias.worker_live[key].arn &&
      contains(aws_lambda_event_source_mapping.worker[key].function_response_types, "ReportBatchItemFailures")
    ])
    error_message = "Each worker event-source mapping must consume its matching queue."
  }

  assert {
    condition = alltrue([
      for key in keys(local.worker_queue_settings) :
      jsondecode(aws_sqs_queue.worker[key].redrive_policy).deadLetterTargetArn == aws_sqs_queue.worker_dlq[key].arn &&
      jsondecode(aws_sqs_queue.worker[key].redrive_policy).maxReceiveCount == 3 &&
      jsondecode(aws_sqs_queue_redrive_allow_policy.worker_dlq[key].redrive_allow_policy).sourceQueueArns == [aws_sqs_queue.worker[key].arn]
    ])
    error_message = "Each worker queue must route after three receives to its matching DLQ."
  }

  assert {
    condition = alltrue([
      for key in keys(local.worker_specs) :
      jsondecode(aws_iam_role_policy.worker_common[key].policy).Statement[2].Resource == aws_sqs_queue.worker[key].arn &&
      contains(jsondecode(aws_iam_role_policy.worker_common[key].policy).Statement[2].Action, "sqs:ReceiveMessage") &&
      contains(jsondecode(aws_iam_role_policy.worker_common[key].policy).Statement[2].Action, "sqs:DeleteMessage")
    ])
    error_message = "Each worker role must receive/delete messages only from its assigned queue."
  }
}

run "stream_aggregator_configuration" {
  command = apply

  variables {
    stage = "dev"
  }

  assert {
    condition = (
      aws_dynamodb_table.main.stream_enabled &&
      aws_dynamodb_table.main.stream_view_type == "NEW_AND_OLD_IMAGES" &&
      aws_lambda_event_source_mapping.stream_aggregator.event_source_arn == aws_dynamodb_table.main.stream_arn &&
      aws_lambda_event_source_mapping.stream_aggregator.function_name == aws_lambda_alias.stream_aggregator_live.arn
    )
    error_message = "The active-stage table must expose NEW_AND_OLD_IMAGES and feed the stream aggregator."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.stream_aggregator.batch_size == 100 &&
      aws_lambda_event_source_mapping.stream_aggregator.bisect_batch_on_function_error &&
      aws_lambda_event_source_mapping.stream_aggregator.maximum_retry_attempts == 3 &&
      aws_lambda_event_source_mapping.stream_aggregator.parallelization_factor == 1
    )
    error_message = "The stream mapping must use the specified batch, retry, bisection, and parallelization settings."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.stream_aggregator.destination_config[0].on_failure[0].destination_arn == aws_sqs_queue.stream_dlq.arn &&
      contains(aws_lambda_event_source_mapping.stream_aggregator.function_response_types, "ReportBatchItemFailures")
    )
    error_message = "Failed stream batches must go to the stream DLQ and the mapping must enable partial batch failures."
  }

  assert {
    condition = (
      contains(
        jsondecode(aws_iam_role_policy.stream_aggregator.policy).Statement[1].Action,
        "dynamodb:GetRecords"
      ) &&
      jsondecode(aws_iam_role_policy.stream_aggregator.policy).Statement[1].Resource == aws_dynamodb_table.main.stream_arn &&
      jsondecode(aws_iam_role_policy.stream_aggregator.policy).Statement[2].Resource == aws_dynamodb_table.main.arn &&
      jsondecode(aws_iam_role_policy.stream_aggregator.policy).Statement[3].Resource == aws_sqs_queue.stream_dlq.arn
    )
    error_message = "The aggregator role must be scoped to its table stream, aggregation table, and stream DLQ."
  }
}

run "production_alarms_and_rollback_aliases" {
  command = apply

  variables {
    stage       = "prod"
    alarm_email = "on-call@example.com"
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.dlq_depth) == 4 &&
      aws_cloudwatch_metric_alarm.dlq_depth["pdf"].metric_name == "ApproximateNumberOfMessagesVisible" &&
      aws_cloudwatch_metric_alarm.dlq_depth["pdf"].threshold == 1 &&
      contains(aws_cloudwatch_metric_alarm.dlq_depth["pdf"].alarm_actions, aws_sns_topic.alarms.arn) &&
      contains(aws_cloudwatch_metric_alarm.dlq_depth["stream"].alarm_actions, aws_sns_topic.alarms.arn)
    )
    error_message = "Each production dead-letter queue must alarm immediately and notify the configured SNS topic."
  }

  assert {
    condition = (
      length(aws_lambda_alias.worker_live) == length(local.worker_specs) &&
      aws_lambda_alias.stream_aggregator_live.name == "live" &&
      alltrue([
        for key in keys(local.worker_specs) :
        aws_lambda_event_source_mapping.worker[key].function_name == aws_lambda_alias.worker_live[key].arn
      ]) &&
      aws_lambda_event_source_mapping.stream_aggregator.function_name == aws_lambda_alias.stream_aggregator_live.arn
    )
    error_message = "Worker and stream event sources must target rollback-capable Lambda live aliases."
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.lambda_errors) == 4 &&
      aws_cloudwatch_metric_alarm.dynamodb_throttles.threshold == 1 &&
      aws_cloudwatch_metric_alarm.lambda_concurrency.threshold == var.lambda_concurrency_alarm_threshold &&
      aws_sns_topic_subscription.alarm_email[0].endpoint == var.alarm_email
    )
    error_message = "Production error, throttle, concurrency, and email-notification alarms must be configured."
  }
}

run "production_requires_alarm_contact" {
  command = plan

  variables {
    stage       = "prod"
    alarm_email = ""
  }

  expect_failures = [var.alarm_email]
}