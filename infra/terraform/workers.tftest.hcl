mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-worker"
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
      aws_lambda_event_source_mapping.worker[key].function_name == aws_lambda_function.worker[key].arn &&
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
