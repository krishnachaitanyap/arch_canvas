variable "project_id" {
  type        = string
  description = "GCP project id"
}

variable "region" {
  type        = string
  default     = "asia-south1"
  description = "Region for GKE, Cloud SQL, GCS and Artifact Registry"
}

variable "name" {
  type    = string
  default = "archcanvas"
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "db_high_availability" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "k8s_namespace" {
  type    = string
  default = "archcanvas"
}

variable "helm_release" {
  type    = string
  default = "archcanvas"
}
