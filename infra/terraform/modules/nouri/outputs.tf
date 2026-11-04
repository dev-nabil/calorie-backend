output "api_url" {
  description = "Cloud Run URL of the API (the public host is var.api_hostname through Cloudflare)."
  value       = google_cloud_run_v2_service.api.uri
}

output "worker_service" {
  description = "Worker Cloud Run service name."
  value       = google_cloud_run_v2_service.worker.name
}

output "artifact_registry" {
  description = "Docker repository for CI (REGION-docker.pkg.dev/PROJECT/nouri)."
  value       = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.nouri.repository_id}"
}

output "workload_identity_provider" {
  description = "Set as GitHub variable GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  description = "Set as GitHub variable GCP_DEPLOY_SERVICE_ACCOUNT."
  value       = google_service_account.deployer.email
}

output "external_secrets_to_fill" {
  description = "Secret Manager secrets to fill with gcloud before the first deploy."
  value       = [for s in var.external_secrets : google_secret_manager_secret.secrets[s].secret_id]
}

output "r2_bucket" {
  description = "R2 bucket for photos, thumbnails, exports and pre-rendered audio."
  value       = cloudflare_r2_bucket.media.name
}
