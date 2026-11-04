# Nouri staging. Apply only from a reviewed plan; never from a laptop with personal credentials.
terraform {
  required_version = ">= 1.9"
  # Remote state: GCS bucket with versioning and uniform access. Partial config, see backend.hcl.example:
  #   terraform init -backend-config=backend.hcl
  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.9"
    }
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 2.21"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

# Credentials come from the environment, never from files in the repo:
#   google: Application Default Credentials / Workload Identity
#   mongodbatlas: MONGODB_ATLAS_CLIENT_ID + MONGODB_ATLAS_CLIENT_SECRET (service account)
#   cloudflare: CLOUDFLARE_API_TOKEN
provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

provider "mongodbatlas" {}

provider "cloudflare" {}

module "nouri" {
  source = "../../modules/nouri"

  environment           = "staging"
  gcp_project_id        = var.gcp_project_id
  gcp_region            = var.gcp_region
  image                 = var.image
  github_repository     = var.github_repository
  api_min_instances     = 1
  worker_min_instances  = 1
  redis_tier            = "BASIC"
  redis_memory_gb       = 1
  atlas_org_id          = var.atlas_org_id
  atlas_region          = var.atlas_region
  atlas_instance_size   = "M10"
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  api_hostname          = var.api_hostname
  admin_app_url         = var.admin_app_url
  cors_origins          = var.cors_origins
  cdn_base_url          = var.cdn_base_url
  plain_env             = var.plain_env
  deletion_protection   = false
}

output "nouri" {
  value = {
    api_url                    = module.nouri.api_url
    artifact_registry          = module.nouri.artifact_registry
    workload_identity_provider = module.nouri.workload_identity_provider
    deploy_service_account     = module.nouri.deploy_service_account
    external_secrets_to_fill   = module.nouri.external_secrets_to_fill
    r2_bucket                  = module.nouri.r2_bucket
  }
}
