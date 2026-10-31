locals {
  worker_prefix        = "${var.table_name}-${var.stage}"
  ssm_param_prefix     = var.ssm_param_prefix != "" ? var.ssm_param_prefix : "/${var.table_name}/${var.stage}"
  documents_bucket_arn = "arn:aws:s3:::${var.documents_bucket_name}"
  worker_specs = {
    pdf = {
      name              = "pdf-worker"
      runtime           = "nodejs26.x"
      handler           = "pdf-worker.handler"
      artifact          = var.pdf_worker_zip_path
      timeout           = 60
      memory            = 1024
      concurrency       = -1 //10
      ephemeral_storage = 2048
      queue             = "pdf"
    }
    report = {
      name              = "report-worker"
      runtime           = "nodejs26.x"
      handler           = "report-worker.handler"
      artifact          = var.report_worker_zip_path
      timeout           = 120
      memory            = 1024
      concurrency       = -1 //5
      ephemeral_storage = 1024
      queue             = "report"
    }
    notification = {
      name              = "notification-worker"
      runtime           = "nodejs26.x"
      handler           = "notification-worker.handler"
      artifact          = var.notification_worker_zip_path
      timeout           = 30
      memory            = 512
      concurrency       = -1 //10
      ephemeral_storage = 512
      queue             = "notification"
    }
  }
  worker_queue_settings = {
    pdf = {
      visibility_timeout = 365
      timeout            = 60
    }
    report = {
      visibility_timeout = 725
      timeout            = 120
    }
    notification = {
      visibility_timeout = 185
      timeout            = 30
    }
  }
}

resource "aws_sqs_queue" "worker_dlq" {
  for_each = local.worker_queue_settings

  name                      = "${local.worker_prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_sqs_queue" "worker" {
  for_each = local.worker_queue_settings

  name                       = "${local.worker_prefix}-${each.key}-queue"
  visibility_timeout_seconds = each.value.visibility_timeout
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.worker_dlq[each.key].arn
    maxReceiveCount     = 3
  })

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "worker_dlq" {
  for_each = local.worker_queue_settings

  queue_url = aws_sqs_queue.worker_dlq[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.worker[each.key].arn]
  })
}

resource "aws_iam_role" "worker" {
  for_each = local.worker_specs

  name = "${local.worker_prefix}-${each.value.name}-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  for_each = local.worker_specs

  name              = "/aws/lambda/${local.worker_prefix}-${each.value.name}"
  retention_in_days = 30

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_iam_role_policy" "worker_common" {
  for_each = local.worker_specs

  name = "${each.value.name}-runtime"
  role = aws_iam_role.worker[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteLambdaLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.worker[each.key].arn}:*"
      },
      {
        Sid      = "ReadWriteWorkerRecords"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"]
        Resource = [aws_dynamodb_table.main.arn, "${aws_dynamodb_table.main.arn}/index/*"]
      },
      {
        Sid      = "ConsumeWorkerQueue"
        Effect   = "Allow"
        Action   = ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
        Resource = aws_sqs_queue.worker[each.value.queue].arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "worker_document_access" {
  for_each = {
    for key, spec in local.worker_specs : key => spec if key == "pdf" || key == "report"
  }

  name = "${each.value.name}-documents"
  role = aws_iam_role.worker[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadWriteDocuments"
      Effect   = "Allow"
      Action   = ["s3:AbortMultipartUpload", "s3:GetObject", "s3:ListMultipartUploadParts", "s3:PutObject"]
      Resource = "${local.documents_bucket_arn}/*"
    }]
  })
}

resource "aws_iam_role_policy" "worker_notification_publish" {
  for_each = {
    for key, spec in local.worker_specs : key => spec if key == "pdf" || key == "report"
  }

  name = "${each.value.name}-notification-publish"
  role = aws_iam_role.worker[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SendNotificationJobs"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.worker["notification"].arn
    }]
  })
}

resource "aws_iam_role_policy" "notification_worker" {
  for_each = {
    for key, spec in local.worker_specs : key => spec if key == "notification"
  }

  name = "notification-worker-delivery"
  role = aws_iam_role.worker[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DeleteNotificationDedupeLocks"
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Sid      = "ReadDocumentsForNotificationLinks"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${local.documents_bucket_arn}/*"
      },
      {
        Sid      = "LoadNotificationSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_param_prefix}/*"
      },
      {
        Sid      = "SendNotificationEmail"
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = "*"
        Condition = {
          StringEquals = { "ses:FromAddress" = var.ses_from_address }
        }
      }
    ]
  })
}
resource "aws_s3_object" "worker_artifact" {
  for_each = local.worker_specs

  bucket                 = var.lambda_artifacts_bucket_name
  key                    = "${var.stage}/workers/${each.value.name}-${substr(filebase64sha256(each.value.artifact), 0, 16)}.zip"
  source                 = each.value.artifact
  source_hash            = filebase64sha256(each.value.artifact)
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}
resource "aws_lambda_function" "worker" {
  for_each = local.worker_specs

  function_name                  = "${local.worker_prefix}-${each.value.name}"
  role                           = aws_iam_role.worker[each.key].arn
  s3_bucket                      = var.lambda_artifacts_bucket_name
  s3_key                         = aws_s3_object.worker_artifact[each.key].key
  source_code_hash               = filebase64sha256(each.value.artifact)
  publish                        = true
  runtime                        = each.value.runtime
  handler                        = each.value.handler
  timeout                        = each.value.timeout
  memory_size                    = each.value.memory
  reserved_concurrent_executions = each.value.concurrency

  ephemeral_storage {
    size = each.value.ephemeral_storage
  }

  environment {
    variables = merge({
      STAGE            = var.stage
      TABLE_NAME       = aws_dynamodb_table.main.name
      LOG_LEVEL        = var.log_level
      SSM_PARAM_PREFIX = local.ssm_param_prefix
      }, each.key == "pdf" ? {
      DOCUMENTS_BUCKET       = var.documents_bucket_name
      PDF_QUEUE_URL          = aws_sqs_queue.worker["pdf"].id
      NOTIFICATION_QUEUE_URL = aws_sqs_queue.worker["notification"].id
      } : {}, each.key == "report" ? {
      DOCUMENTS_BUCKET       = var.documents_bucket_name
      PDF_QUEUE_URL          = aws_sqs_queue.worker["pdf"].id
      REPORT_QUEUE_URL       = aws_sqs_queue.worker["report"].id
      NOTIFICATION_QUEUE_URL = aws_sqs_queue.worker["notification"].id
      } : {}, each.key == "notification" ? {
      NOTIFICATION_QUEUE_URL = aws_sqs_queue.worker["notification"].id
      SES_FROM_ADDRESS       = var.ses_from_address
      SES_CONFIG_SET         = var.ses_config_set
    } : {})
  }

  depends_on = [aws_iam_role_policy.worker_common, aws_iam_role_policy.worker_document_access, aws_iam_role_policy.worker_notification_publish, aws_iam_role_policy.notification_worker, aws_cloudwatch_log_group.worker]

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_lambda_alias" "worker_live" {
  for_each = local.worker_specs

  name             = "live"
  function_name    = aws_lambda_function.worker[each.key].function_name
  function_version = aws_lambda_function.worker[each.key].version
}

resource "aws_lambda_event_source_mapping" "worker" {
  for_each = local.worker_specs

  event_source_arn                   = aws_sqs_queue.worker[each.value.queue].arn
  function_name                      = aws_lambda_alias.worker_live[each.key].arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true

  depends_on = [aws_iam_role_policy.worker_common, aws_iam_role_policy.worker_document_access, aws_iam_role_policy.worker_notification_publish, aws_iam_role_policy.notification_worker, aws_cloudwatch_log_group.worker]
}

resource "aws_sqs_queue" "stream_dlq" {
  name                      = "${local.worker_prefix}-stream-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_iam_role" "stream_aggregator" {
  name = "${local.worker_prefix}-stream-aggregator-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_cloudwatch_log_group" "stream_aggregator" {
  name              = "/aws/lambda/${local.worker_prefix}-stream-aggregator"
  retention_in_days = 30

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_iam_role_policy" "stream_aggregator" {
  name = "stream-aggregator-runtime"
  role = aws_iam_role.stream_aggregator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteLambdaLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.stream_aggregator.arn}:*"
      },
      {
        Sid      = "ReadTableStream"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
        Resource = aws_dynamodb_table.main.stream_arn
      },
      {
        Sid      = "ReadAndUpdateAggregationItems"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:TransactWriteItems"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Sid      = "SendFailedStreamBatches"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.stream_dlq.arn
      }
    ]
  })
}

resource "aws_s3_object" "stream_aggregator_artifact" {
  bucket                 = var.lambda_artifacts_bucket_name
  key                    = "${var.stage}/workers/stream-aggregator-${substr(filebase64sha256(var.stream_aggregator_zip_path), 0, 16)}.zip"
  source                 = var.stream_aggregator_zip_path
  source_hash            = filebase64sha256(var.stream_aggregator_zip_path)
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "aws_lambda_function" "stream_aggregator" {
  function_name                  = "${local.worker_prefix}-stream-aggregator"
  role                           = aws_iam_role.stream_aggregator.arn
  s3_bucket                      = var.lambda_artifacts_bucket_name
  s3_key                         = aws_s3_object.stream_aggregator_artifact.key
  source_code_hash               = filebase64sha256(var.stream_aggregator_zip_path)
  publish                        = true
  runtime                        = "nodejs26.x"
  handler                        = "stream-aggregator.handler"
  timeout                        = 30
  memory_size                    = 512
  reserved_concurrent_executions = -1

  environment {
    variables = {
      STAGE      = var.stage
      TABLE_NAME = aws_dynamodb_table.main.name
      LOG_LEVEL  = var.log_level
    }
  }

  depends_on = [aws_iam_role_policy.stream_aggregator, aws_cloudwatch_log_group.stream_aggregator]

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_lambda_alias" "stream_aggregator_live" {
  name             = "live"
  function_name    = aws_lambda_function.stream_aggregator.function_name
  function_version = aws_lambda_function.stream_aggregator.version
}

resource "aws_lambda_event_source_mapping" "stream_aggregator" {
  event_source_arn               = aws_dynamodb_table.main.stream_arn
  function_name                  = aws_lambda_alias.stream_aggregator_live.arn
  starting_position              = "LATEST"
  batch_size                     = 100
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = 3
  parallelization_factor         = 1
  function_response_types        = ["ReportBatchItemFailures"]
  enabled                        = true

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.stream_dlq.arn
    }
  }

  depends_on = [aws_iam_role_policy.stream_aggregator, aws_cloudwatch_log_group.stream_aggregator]
}

