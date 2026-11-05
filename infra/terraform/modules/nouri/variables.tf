# All inputs for one Nouri environment (staging or prod). No secret values here: generated secrets
# are created by Terraform (random_password) and external ones are added to Secret Manager by hand
# (see infra/terraform/README.md and ../nouri-docs/runbook.md).

variable "environment" {
  description = "Environment name, used in resource names: staging | prod."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "gcp_project_id" {
  description = "GCP project that hosts Cloud Run, Memorystore, Secret Manager and Artifact Registry."
  type        = string
}

variable "gcp_region" {
  description = "GCP region (DEC-17, chosen by launch market, OQ-05), e.g. europe-west2."
  type        = string
}

variable "image" {
  description = "Container image for api and worker. CI deploys new revisions with gcloud; Terraform only sets the first one."
  type        = string
}

variable "api_min_instances" {
  description = "Minimum API instances (DEC-17: 2 in production)."
  type        = number
  default     = 2
}

variable "api_max_instances" {
  description = "Maximum API instances."
  type        = number
  default     = 50
}

variable "worker_min_instances" {
  description = "Minimum worker instances (always-on CPU; BullMQ consumers)."
  type        = number
  default     = 2
}

variable "worker_max_instances" {
  description = "Maximum worker instances (scale manually on queue depth; see runbook)."
  type        = number
  default     = 10
}

variable "redis_memory_gb" {
  description = "Memorystore Redis size in GB (DEC-04)."
  type        = number
  default     = 1
}

variable "redis_tier" {
  description = "BASIC (staging) or STANDARD_HA (prod)."
  type        = string
  default     = "STANDARD_HA"
}

variable "vpc_cidr" {
  description = "Subnet range for Cloud Run Direct VPC egress; must not overlap atlas_cidr."
  type        = string
  default     = "10.10.0.0/20"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through Workload Identity Federation."
  type        = string
}

variable "atlas_org_id" {
  description = "MongoDB Atlas organisation id."
  type        = string
}

variable "atlas_region" {
  description = "Atlas region name for GCP, same region as Cloud Run, e.g. EUROPE_WEST_2."
  type        = string
}

variable "atlas_instance_size" {
  description = "Dedicated cluster tier (DEC-03: M30 or above in production)."
  type        = string
  default     = "M30"
}

variable "atlas_max_instance_size" {
  description = "Upper bound for compute auto-scaling."
  type        = string
  default     = "M60"
}

variable "atlas_cidr" {
  description = "CIDR for the Atlas GCP network container (peering)."
  type        = string
  default     = "192.168.0.0/18"
}

variable "database_name" {
  description = "Application database name."
  type        = string
  default     = "nouri"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id (R2)."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone of the public domain (OQ-08)."
  type        = string
}

variable "api_hostname" {
  description = "Public API host name proxied by Cloudflare, e.g. api.example.com or api.staging.example.com."
  type        = string
}

variable "admin_app_url" {
  description = "Admin panel origin used in invite links and CORS."
  type        = string
}

variable "cors_origins" {
  description = "Allowed browser origins (web and admin)."
  type        = list(string)
}

variable "r2_location" {
  description = "R2 location hint: weur, eeur, wnam, enam, apac or oc."
  type        = string
  default     = "weur"
}

variable "cdn_base_url" {
  description = "Public CDN base URL for signed photo and audio URLs (served by a Cloudflare Worker in front of R2)."
  type        = string
}

variable "auth_rate_limit_per_minute" {
  description = "Edge limit per IP and colo for /v1/auth/* (the API has its own finer limits)."
  type        = number
  default     = 30
}

variable "ai_rate_limit_per_minute" {
  description = "Edge limit per IP and colo for AI routes (scans, parse, turns, speech)."
  type        = number
  default     = 60
}

variable "external_secrets" {
  description = "Secret Manager secrets whose values are added out of band (never in Terraform state)."
  type        = list(string)
  default = [
    "GEMINI_API_KEY",
    "EMAIL_API_KEY",
    "REVENUECAT_API_KEY",
    "REVENUECAT_WEBHOOK_SECRET",
    "TURNSTILE_SECRET",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "SENTRY_DSN",
  ]
}

variable "plain_env" {
  description = "Extra non-secret environment variables for api and worker (e.g. APPLE_BUNDLE_ID, GOOGLE_CLIENT_IDS, PLAY_INTEGRITY_PACKAGE)."
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  description = "Protect Cloud Run services and the Atlas cluster from deletion (true in prod)."
  type        = bool
  default     = true
}
