mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-api"
    }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      api_endpoint  = "https://mock-api.execute-api.eu-north-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:eu-north-1:123456789012:mock-api"
      id            = "mock-api"
    }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn        = "arn:aws:dynamodb:eu-north-1:123456789012:table/mock-table"
      name       = "mock-table"
      stream_arn = "arn:aws:dynamodb:eu-north-1:123456789012:table/mock-table/stream/mock-stream"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:eu-north-1:123456789012:mock-queue"
      id  = "https://sqs.eu-north-1.amazonaws.com/123456789012/mock-queue"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:eu-north-1:123456789012:mock-alarms"
    }
  }
}

run "api_gateway_and_lambda_configuration" {
  command = apply

  variables {
    stage           = "dev"
    allowed_origins = ["https://dev.example.test"]
  }

  assert {
    condition = (
      aws_lambda_function.api["api_handler"].runtime == "nodejs26.x" &&
      aws_lambda_function.api["api_handler"].handler == "api-handler.handler" &&
      length(aws_lambda_function.api["api_handler"].architectures) == 1 &&
      contains(aws_lambda_function.api["api_handler"].architectures, "x86_64") &&
      aws_lambda_function.api["api_handler"].memory_size == 1024 &&
      aws_lambda_function.api["api_handler"].timeout == 29 &&
      aws_lambda_function.api["api_handler"].reserved_concurrent_executions == 50 &&
      aws_lambda_function.api["api_handler"].ephemeral_storage[0].size == 512 &&
      aws_lambda_function.api["authorizer"].runtime == "nodejs26.x" &&
      aws_lambda_function.api["authorizer"].handler == "authorizer.handler" &&
      length(aws_lambda_function.api["authorizer"].architectures) == 1 &&
      contains(aws_lambda_function.api["authorizer"].architectures, "x86_64") &&
      aws_lambda_function.api["authorizer"].memory_size == 256 &&
      aws_lambda_function.api["authorizer"].timeout == 5 &&
      aws_lambda_function.api["authorizer"].reserved_concurrent_executions == 20
    )
    error_message = "The API and authorizer Lambdas must use the pinned runtime and specified execution limits."
  }

  assert {
    condition = (
      startswith(aws_s3_object.api_artifact["api_handler"].key, "dev/api/api-handler-") &&
      startswith(aws_s3_object.api_artifact["authorizer"].key, "dev/api/authorizer-") &&
      aws_s3_object.api_artifact["api_handler"].source_hash == filebase64sha256(var.api_handler_zip_path) &&
      aws_s3_object.api_artifact["authorizer"].source_hash == filebase64sha256(var.authorizer_zip_path) &&
      aws_lambda_function.api["api_handler"].source_code_hash == filebase64sha256(var.api_handler_zip_path) &&
      aws_lambda_function.api["authorizer"].source_code_hash == filebase64sha256(var.authorizer_zip_path) &&
      aws_lambda_alias.api_live["api_handler"].name == "live" &&
      aws_lambda_alias.api_live["authorizer"].name == "live"
    )
    error_message = "Both API artifacts must use content-hashed stage keys and published live aliases."
  }

  assert {
    condition = (
      aws_apigatewayv2_api.http.protocol_type == "HTTP" &&
      toset(aws_apigatewayv2_api.http.cors_configuration[0].allow_origins) == toset(var.allowed_origins) &&
      contains(aws_apigatewayv2_api.http.cors_configuration[0].allow_methods, "HEAD") &&
      aws_apigatewayv2_api.http.cors_configuration[0].allow_credentials &&
      aws_apigatewayv2_api.http.cors_configuration[0].max_age == 600
    )
    error_message = "The HTTP API must use exact-origin CORS with credentials and the configured maximum age."
  }

  assert {
    condition = (
      aws_apigatewayv2_stage.default.name == "$default" &&
      aws_apigatewayv2_stage.default.auto_deploy &&
      aws_apigatewayv2_stage.default.default_route_settings[0].throttling_burst_limit == 100 &&
      aws_apigatewayv2_stage.default.default_route_settings[0].throttling_rate_limit == 50
    )
    error_message = "The auto-deployed default stage must enforce the configured route throttle."
  }

  assert {
    condition = (
      aws_apigatewayv2_authorizer.jwt.authorizer_payload_format_version == "2.0" &&
      aws_apigatewayv2_authorizer.jwt.authorizer_result_ttl_in_seconds == 60 &&
      aws_apigatewayv2_authorizer.jwt.enable_simple_responses &&
      toset(aws_apigatewayv2_authorizer.jwt.identity_sources) == toset(["$request.header.Authorization"])
    )
    error_message = "The Lambda authorizer must use HTTP API v2 simple responses with a 60-second cache."
  }

  assert {
    condition = (
      aws_apigatewayv2_route.api_proxy.route_key == "ANY /{proxy+}" &&
      aws_apigatewayv2_route.api_proxy.authorization_type == "CUSTOM" &&
      aws_apigatewayv2_route.health.authorization_type == "NONE" &&
      aws_apigatewayv2_route.api_proxy.target == "integrations/${aws_apigatewayv2_integration.api_handler.id}" &&
      aws_apigatewayv2_route.health.target == "integrations/${aws_apigatewayv2_integration.api_handler.id}" &&
      strcontains(aws_apigatewayv2_integration.api_handler.integration_uri, aws_lambda_alias.api_live["api_handler"].arn) &&
      strcontains(aws_apigatewayv2_authorizer.jwt.authorizer_uri, aws_lambda_alias.api_live["authorizer"].arn)
    )
    error_message = "The proxy route must be authorizer-protected and the health endpoint must remain public."
  }

  assert {
    condition = (
      contains(jsondecode(aws_iam_role_policy.api_handler.policy).Statement[1].Action, "dynamodb:Query") &&
      contains(jsondecode(aws_iam_role_policy.api_handler.policy).Statement[1].Action, "dynamodb:BatchWriteItem") &&
      !contains(jsondecode(aws_iam_role_policy.api_handler.policy).Statement[1].Action, "dynamodb:Scan") &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[2].Resource == "${local.documents_bucket_arn}/*" &&
      toset(jsondecode(aws_iam_role_policy.api_handler.policy).Statement[2].Action) == toset(["s3:GetObject", "s3:PutObject"]) &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[3].Resource == "arn:aws:s3:::${var.photos_bucket_name}/*" &&
      toset(jsondecode(aws_iam_role_policy.api_handler.policy).Statement[3].Action) == toset(["s3:GetObject", "s3:PutObject"]) &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[4].Resource == [for queue in aws_sqs_queue.worker : queue.arn] &&
      jsondecode(aws_iam_role_policy.authorizer.policy).Statement[1].Action == ["dynamodb:GetItem"] &&
      jsondecode(aws_iam_role_policy.authorizer.policy).Statement[1].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["SESSION#*"] &&
      jsondecode(aws_iam_role_policy.authorizer.policy).Statement[2].Resource == "arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_param_prefix}/jwt/public-key"
    )
    error_message = "API and authorizer policies must remain scoped to their required DynamoDB, S3, SQS, and SSM resources."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[6].Action == ["dynamodb:DescribeTable"] &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[6].Resource == aws_dynamodb_table.main.arn &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[7].Action == ["sqs:GetQueueAttributes"] &&
      toset(jsondecode(aws_iam_role_policy.api_handler.policy).Statement[7].Resource) == toset(concat(
        [for queue in aws_sqs_queue.worker : queue.arn],
        [for queue in aws_sqs_queue.worker_dlq : queue.arn],
      )) &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[8].Action == ["cloudwatch:GetMetricStatistics"] &&
      jsondecode(aws_iam_role_policy.api_handler.policy).Statement[8].Resource == "*"
    )
    error_message = "Admin health permissions must describe only the stage table, inspect only worker queues/DLQs, and use CloudWatch's required wildcard resource."
  }

  assert {
    condition = (
      aws_lambda_function.api["api_handler"].environment[0].variables.ALLOWED_ORIGINS == join(",", var.allowed_origins) &&
      aws_lambda_function.api["api_handler"].environment[0].variables.PDF_QUEUE_URL == aws_sqs_queue.worker["pdf"].id &&
      aws_lambda_function.api["api_handler"].environment[0].variables.REPORT_QUEUE_URL == aws_sqs_queue.worker["report"].id &&
      aws_lambda_function.api["api_handler"].environment[0].variables.NOTIFICATION_QUEUE_URL == aws_sqs_queue.worker["notification"].id &&
      aws_lambda_function.api["api_handler"].environment[0].variables.PDF_DLQ_URL == aws_sqs_queue.worker_dlq["pdf"].id &&
      aws_lambda_function.api["api_handler"].environment[0].variables.REPORT_DLQ_URL == aws_sqs_queue.worker_dlq["report"].id &&
      aws_lambda_function.api["api_handler"].environment[0].variables.NOTIFICATION_DLQ_URL == aws_sqs_queue.worker_dlq["notification"].id &&
      toset(split(",", aws_lambda_function.api["api_handler"].environment[0].variables.ADMIN_LAMBDA_FUNCTIONS)) == toset(concat(
        ["${local.worker_prefix}-api-handler", "${local.worker_prefix}-authorizer"],
        [for worker in local.worker_specs : "${local.worker_prefix}-${worker.name}"],
        ["${local.worker_prefix}-stream-aggregator"],
      )) &&
      aws_lambda_permission.api_gateway["api_handler"].qualifier == "live" &&
      aws_lambda_permission.api_gateway["authorizer"].qualifier == "live" &&
      aws_cloudwatch_metric_alarm.api_gateway_5xx.metric_name == "5xx" &&
      aws_cloudwatch_metric_alarm.api_integration_latency.extended_statistic == "p99" &&
      aws_cloudwatch_metric_alarm.lambda_errors["api_handler"].dimensions.FunctionName == aws_lambda_function.api["api_handler"].function_name &&
      aws_cloudwatch_metric_alarm.lambda_errors["authorizer"].dimensions.FunctionName == aws_lambda_function.api["authorizer"].function_name &&
      output.api_endpoint == aws_apigatewayv2_api.http.api_endpoint &&
      output.api_handler_alias_arn == aws_lambda_alias.api_live["api_handler"].arn &&
      output.authorizer_alias_arn == aws_lambda_alias.api_live["authorizer"].arn &&
      output.photos_bucket_arn == "arn:aws:s3:::${var.photos_bucket_name}"
    )
    error_message = "API Lambda configuration, alias invoke permissions, environment, and API operational alarms must be wired."
  }
}

run "api_rejects_wildcard_cors_origin" {
  command = plan

  variables {
    stage           = "dev"
    allowed_origins = ["*"]
  }

  expect_failures = [var.allowed_origins]
}
