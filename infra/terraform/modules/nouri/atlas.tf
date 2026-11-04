# MongoDB Atlas (DEC-03): dedicated cluster in the same region, VPC peering to the GCP network,
# one least-privilege database user per app (api, worker).
resource "mongodbatlas_project" "main" {
  name   = "nouri-${var.environment}"
  org_id = var.atlas_org_id
}

resource "mongodbatlas_network_container" "gcp" {
  project_id       = mongodbatlas_project.main.id
  atlas_cidr_block = var.atlas_cidr
  provider_name    = "GCP"
}

resource "mongodbatlas_network_peering" "gcp" {
  project_id     = mongodbatlas_project.main.id
  container_id   = mongodbatlas_network_container.gcp.container_id
  provider_name  = "GCP"
  gcp_project_id = var.gcp_project_id
  network_name   = google_compute_network.main.name
}

resource "google_compute_network_peering" "atlas" {
  name         = "nouri-${var.environment}-atlas"
  network      = google_compute_network.main.self_link
  peer_network = "https://www.googleapis.com/compute/v1/projects/${mongodbatlas_network_peering.gcp.atlas_gcp_project_id}/global/networks/${mongodbatlas_network_peering.gcp.atlas_vpc_name}"
}

# Only the Cloud Run subnet may connect (network access only from the cloud project, plan section 14).
resource "mongodbatlas_project_ip_access_list" "run" {
  project_id = mongodbatlas_project.main.id
  cidr_block = var.vpc_cidr
  comment    = "Cloud Run Direct VPC egress (${var.environment})"
}

resource "mongodbatlas_advanced_cluster" "main" {
  project_id                     = mongodbatlas_project.main.id
  name                           = "nouri-${var.environment}"
  cluster_type                   = "REPLICASET"
  backup_enabled                 = true
  pit_enabled                    = true # point-in-time restore (runbook restore drill)
  termination_protection_enabled = var.deletion_protection

  replication_specs = [{
    region_configs = [{
      provider_name = "GCP"
      region_name   = var.atlas_region
      priority      = 7
      electable_specs = {
        instance_size = var.atlas_instance_size
        node_count    = 3
      }
      auto_scaling = {
        compute_enabled            = true
        compute_scale_down_enabled = true
        compute_min_instance_size  = var.atlas_instance_size
        compute_max_instance_size  = var.atlas_max_instance_size
        disk_gb_enabled            = true
      }
    }]
  }]

  lifecycle {
    ignore_changes = [replication_specs[0].region_configs[0].electable_specs.instance_size] # auto-scaling owns it
  }
  depends_on = [mongodbatlas_network_peering.gcp]
}

resource "random_password" "db" {
  for_each = toset(["api", "worker"])
  length   = 40
  special  = false
}

resource "mongodbatlas_database_user" "app" {
  for_each           = toset(["api", "worker"])
  project_id         = mongodbatlas_project.main.id
  username           = "nouri-${each.value}"
  password           = random_password.db[each.value].result
  auth_database_name = "admin"

  roles {
    role_name     = "readWrite"
    database_name = var.database_name
  }

  scopes {
    name = mongodbatlas_advanced_cluster.main.name
    type = "CLUSTER"
  }
}

locals {
  atlas_private_host = trimprefix(mongodbatlas_advanced_cluster.main.connection_strings.private_srv, "mongodb+srv://")
}

resource "google_secret_manager_secret_version" "mongodb_uri" {
  for_each    = { api = "MONGODB_URI_API", worker = "MONGODB_URI_WORKER" }
  secret      = google_secret_manager_secret.secrets[each.value].id
  secret_data = "mongodb+srv://${mongodbatlas_database_user.app[each.key].username}:${random_password.db[each.key].result}@${local.atlas_private_host}/${var.database_name}?retryWrites=true&w=majority"
}
