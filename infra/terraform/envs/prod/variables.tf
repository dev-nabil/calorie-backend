variable "gcp_project_id" {
  description = "GCP project for this environment."
  type        = string
}

variable "gcp_region" {
  description = "GCP region, e.g. europe-west2 (OQ-05)."
  type        = string
}

variable "image" {
  description = "Initial image; CI deploys later revisions (REGION-docker.pkg.dev/PROJECT/nouri/backend:SHA)."
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to deploy."
  type        = string
}

variable "atlas_org_id" {
  description = "MongoDB Atlas organisation id."
  type        = string
}

variable "atlas_region" {
  description = "Atlas GCP region name, e.g. EUROPE_WEST_2."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of the public domain."
  type        = string
}

variable "api_hostname" {
  description = "Public API host name."
  type        = string
}

variable "admin_app_url" {
  description = "Admin panel origin."
  type        = string
}

variable "cors_origins" {
  description = "Browser origins allowed by the API."
  type        = list(string)
}

variable "cdn_base_url" {
  description = "CDN base URL (Cloudflare Worker in front of R2)."
  type        = string
}

variable "plain_env" {
  description = "Non-secret API settings: APPLE_BUNDLE_ID, APPLE_SERVICE_ID, APPLE_APP_ATTEST_TEAM_ID, GOOGLE_CLIENT_IDS, PLAY_INTEGRITY_PACKAGE, EMAIL_FROM, OPENAI_MONTHLY_BUDGET_USD, OTEL_EXPORTER_OTLP_ENDPOINT."
  type        = map(string)
  default     = {}
}
