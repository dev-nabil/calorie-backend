# Private network: Cloud Run Direct VPC egress → Memorystore (private IP) and Atlas (VPC peering).
resource "google_compute_network" "main" {
  project                 = var.gcp_project_id
  name                    = "nouri-${var.environment}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "run" {
  project                  = var.gcp_project_id
  name                     = "nouri-${var.environment}-run"
  region                   = var.gcp_region
  network                  = google_compute_network.main.id
  ip_cidr_range            = var.vpc_cidr
  private_ip_google_access = true
}

resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ])
  project            = var.gcp_project_id
  service            = each.value
  disable_on_destroy = false
}
