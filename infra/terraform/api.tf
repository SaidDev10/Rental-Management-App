locals {
  api_lambda_specs = {
    api_handler = {
      name              = "api-handler"
      runtime           = "nodejs26.x"
      handler           = "api-handler.handler"
      artifact          = var.api_handler_zip_path
      memory            = 1024
      timeout           = 29
      concurrency       = -1
      ephemeral_storage = 512
    }
    authorizer = {
      name              = "authorizer"
      runtime           = "nodejs26.x"
      handler           = "authorizer.handler"
      artifact          = var.authorizer_zip_path
      memory            = 256
      timeout           = 5
      concurrency       = -1
      ephemeral_storage = 512
    }
  }
}

resource "aws_iam_role" "api" {
  for_each = local.api_lambda_specs

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

resource "aws_cloudwatch_log_group" "api" {
  for_each = local.api_lambda_specs

  name              = "/aws/lambda/${local.worker_prefix}-${each.value.name}"
  retention_in_days = 30

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_iam_role_policy" "api_handler" {
  name = "api-handler-runtime"
  role = aws_iam_role.api["api_handler"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteLambdaLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api["api_handler"].arn}:*"
      },
      {
        Sid      = "ReadWriteApplicationRecords"
        Effect   = "Allow"
        Action   = ["dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:TransactWriteItems", "dynamodb:UpdateItem"]
        Resource = [aws_dynamodb_table.main.arn, "${aws_dynamodb_table.main.arn}/index/*"]
      },
      {
        Sid      = "ReadWriteDocuments"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${local.documents_bucket_arn}/*"
      },
      {
        Sid      = "ReadWritePhotos"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::${var.photos_bucket_name}/*"
      },
      {
        Sid      = "EnqueueBackgroundJobs"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [for queue in aws_sqs_queue.worker : queue.arn]
      },
      {
        Sid      = "LoadApplicationSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_param_prefix}/*"
      },
      {
        Sid      = "DescribeApplicationTable"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Sid    = "ReadOperationalQueueDepth"
        Effect = "Allow"
        Action = ["sqs:GetQueueAttributes"]
        Resource = concat(
          [for queue in aws_sqs_queue.worker : queue.arn],
          [for queue in aws_sqs_queue.worker_dlq : queue.arn],
        )
      },
      {
        Sid    = "ReadLambdaErrorMetrics"
        Effect = "Allow"
        Action = ["cloudwatch:GetMetricStatistics"]
        # CloudWatch GetMetricStatistics does not support resource-level IAM permissions.
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "authorizer" {
  name = "authorizer-runtime"
  role = aws_iam_role.api["authorizer"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteLambdaLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api["authorizer"].arn}:*"
      },
      {
        Sid      = "ReadSessionRecords"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.main.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["SESSION#*"]
          }
        }
      },
      {
        Sid      = "LoadJwtPublicKey"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_param_prefix}/jwt/public-key"
      }
    ]
  })
}

resource "aws_s3_object" "api_artifact" {
  for_each = local.api_lambda_specs

  bucket                 = var.lambda_artifacts_bucket_name
  key                    = "${var.stage}/api/${each.value.name}-${substr(filebase64sha256(each.value.artifact), 0, 16)}.zip"
  source                 = each.value.artifact
  source_hash            = filebase64sha256(each.value.artifact)
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "aws_lambda_function" "api" {
  for_each = local.api_lambda_specs

  function_name                  = "${local.worker_prefix}-${each.value.name}"
  role                           = aws_iam_role.api[each.key].arn
  s3_bucket                      = var.lambda_artifacts_bucket_name
  s3_key                         = aws_s3_object.api_artifact[each.key].key
  source_code_hash               = filebase64sha256(each.value.artifact)
  publish                        = true
  runtime                        = each.value.runtime
  handler                        = each.value.handler
  architectures                  = ["x86_64"]
  timeout                        = each.value.timeout
  memory_size                    = each.value.memory
  reserved_concurrent_executions = each.value.concurrency

  ephemeral_storage {
    size = each.value.ephemeral_storage
  }

  environment {
    variables = each.key == "api_handler" ? {
      STAGE                  = var.stage
      TABLE_NAME             = aws_dynamodb_table.main.name
      LOG_LEVEL              = var.log_level
      DOCUMENTS_BUCKET       = var.documents_bucket_name
      PHOTOS_BUCKET          = var.photos_bucket_name
      PDF_QUEUE_URL          = aws_sqs_queue.worker["pdf"].id
      REPORT_QUEUE_URL       = aws_sqs_queue.worker["report"].id
      NOTIFICATION_QUEUE_URL = aws_sqs_queue.worker["notification"].id
      PDF_DLQ_URL            = aws_sqs_queue.worker_dlq["pdf"].id
      REPORT_DLQ_URL         = aws_sqs_queue.worker_dlq["report"].id
      NOTIFICATION_DLQ_URL   = aws_sqs_queue.worker_dlq["notification"].id
      ADMIN_LAMBDA_FUNCTIONS = join(",", concat(
        ["${local.worker_prefix}-api-handler", "${local.worker_prefix}-authorizer"],
        [for worker in local.worker_specs : "${local.worker_prefix}-${worker.name}"],
        ["${local.worker_prefix}-stream-aggregator"],
      ))
      SSM_PARAM_PREFIX = local.ssm_param_prefix
      ALLOWED_ORIGINS  = join(",", var.allowed_origins)
      } : {
      STAGE            = var.stage
      SSM_PARAM_PREFIX = local.ssm_param_prefix
    }
  }

  depends_on = [
    aws_iam_role_policy.api_handler,
    aws_iam_role_policy.authorizer,
    aws_cloudwatch_log_group.api,
  ]

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_lambda_alias" "api_live" {
  for_each = local.api_lambda_specs

  name             = "live"
  function_name    = aws_lambda_function.api[each.key].function_name
  function_version = aws_lambda_function.api[each.key].version
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.worker_prefix}-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = true
    allow_headers     = ["authorization", "content-type"]
    allow_methods     = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    allow_origins     = var.allowed_origins
    max_age           = 600
  }

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}

resource "aws_lambda_permission" "api_gateway" {
  for_each = local.api_lambda_specs

  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[each.key].function_name
  qualifier     = aws_lambda_alias.api_live[each.key].name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id                            = aws_apigatewayv2_api.http.id
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_alias.api_live["authorizer"].arn}/invocations"
  identity_sources                  = ["$request.header.Authorization"]
  name                              = "${local.worker_prefix}-jwt-authorizer"
  authorizer_payload_format_version = "2.0"
  authorizer_result_ttl_in_seconds  = 60
  enable_simple_responses           = true

  depends_on = [aws_lambda_permission.api_gateway["authorizer"]]
}

resource "aws_apigatewayv2_integration" "api_handler" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_alias.api_live["api_handler"].arn}/invocations"
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000

  depends_on = [aws_lambda_permission.api_gateway["api_handler"]]
}

resource "aws_apigatewayv2_route" "api_proxy" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "ANY /{proxy+}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.api_handler.id}"
}

resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /health"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.api_handler.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }

  tags = {
    Stage     = var.stage
    ManagedBy = "Terraform"
  }
}
