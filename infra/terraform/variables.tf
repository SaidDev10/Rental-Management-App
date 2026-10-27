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

variable "ssm_param_prefix" {
  description = "SSM path prefix for worker secrets; defaults to /<table_name>/<stage>."
  type        = string
  default     = ""
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