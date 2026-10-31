variable "aws_region" {
  description = "AWS region in which to create the DynamoDB table and worker stack."
  type        = string
  default     = "eu-north-1"
}

variable "stage" {
  description = "Deployment stage. Deletion protection is enabled for production."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.stage)
    error_message = "stage must be either dev or prod."
  }
}

variable "table_name" {
  description = "Base DynamoDB table name consumed by the backend as TABLE_NAME. The stage is appended as -<stage>-db."
  type        = string
  default     = "rental-app"
}

variable "lambda_artifacts_bucket_name" {
  description = "Existing private S3 bucket used to upload worker ZIPs for Lambda deployment."
  type        = string
  default     = "rental-management-artifacts"
}

variable "documents_bucket_name" {
  description = "Existing S3 bucket used by PDF/report workers and notification document links."
  type        = string
  default     = "rental-management-documents"
}

variable "photos_bucket_name" {
  description = "Existing S3 bucket used by the API to store property photos."
  type        = string
  default     = "rental-management-documents"
}

variable "ssm_param_prefix" {
  description = "SSM path prefix for worker secrets; defaults to /<table_name>/<stage>."
  type        = string
  default     = ""
}

variable "allowed_origins" {
  description = "Exact browser origins allowed by API Gateway and the API Lambda."
  type        = list(string)

  validation {
    condition = (
      length(var.allowed_origins) > 0 &&
      alltrue([
        for origin in var.allowed_origins :
        origin == trimspace(origin) &&
        !strcontains(origin, "*") &&
        !strcontains(origin, ",") &&
        can(regex("^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", origin))
      ]) &&
      (var.stage != "prod" || alltrue([for origin in var.allowed_origins : startswith(origin, "https://")]))
    )
    error_message = "allowed_origins must contain exact HTTP(S) origins without paths or wildcards; production origins must use HTTPS."
  }
}

variable "ses_from_address" {
  description = "Verified SES sender address used by the notification worker."
  type        = string
  default     = "said.idbesslam@gmail.com"
}

variable "ses_config_set" {
  description = "SES configuration set used for notification delivery."
  type        = string
  default     = "rental-management-ses-config-set"
}

variable "log_level" {
  description = "Application log level for worker Lambdas."
  type        = string
  default     = "info"
}

variable "pdf_worker_zip_path" {
  description = "Path to the built PDF worker Lambda ZIP, relative to the Terraform module."
  type        = string
  default     = "../../dist/pdf-worker.zip"
}

variable "api_handler_zip_path" {
  description = "Path to the built API handler Lambda ZIP, relative to the Terraform module."
  type        = string
  default     = "../../dist/api-handler.zip"
}

variable "authorizer_zip_path" {
  description = "Path to the built Lambda authorizer ZIP, relative to the Terraform module."
  type        = string
  default     = "../../dist/authorizer.zip"
}

variable "report_worker_zip_path" {
  description = "Path to the built report worker Lambda ZIP, relative to the Terraform module."
  type        = string
  default     = "../../dist/report-worker.zip"
}

variable "notification_worker_zip_path" {
  description = "Path to the built notification worker Lambda ZIP, relative to the Terraform module."
  type        = string
  default     = "../../dist/notification-worker.zip"
}

variable "stream_aggregator_zip_path" {
  description = "Path to the built DynamoDB stream aggregator Lambda ZIP, relative to the Terraform module."
  type        = string
  default     = "../../dist/stream-aggregator.zip"
}
variable "alarm_email" {
  description = "Verified email endpoint for production CloudWatch alarm notifications; optional outside production."
  type        = string
  default     = ""

  validation {
    condition     = var.stage != "prod" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", trimspace(var.alarm_email)))
    error_message = "alarm_email must be a valid notification address when stage is prod."
  }
}

variable "lambda_concurrency_alarm_threshold" {
  description = "Account-wide concurrent Lambda executions that trigger the capacity alarm."
  type        = number
  default     = 40

  validation {
    condition     = var.lambda_concurrency_alarm_threshold > 0
    error_message = "lambda_concurrency_alarm_threshold must be greater than zero."
  }
}
