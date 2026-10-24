variable "aws_region" {
  description = "AWS region in which to create the DynamoDB table."
  type        = string
  default     = "eu-west-1"
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
  description = "DynamoDB table name consumed by the backend as TABLE_NAME."
  type        = string
  default     = "rental-app-main"
}
