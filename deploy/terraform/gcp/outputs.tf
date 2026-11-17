output "gke_cluster" {
  value = google_container_cluster.gke.name
}

output "get_credentials" {
  value = "gcloud container clusters get-credentials ${google_container_cluster.gke.name} --region ${var.region} --project ${var.project_id}"
}

output "image_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "cloudsql_private_ip" {
  value = google_sql_database_instance.pg.private_ip_address
}

output "database_url_secret" {
  value       = google_secret_manager_secret.database_url.secret_id
  description = "Secret Manager secret holding DATABASE_URL"
}

output "api_gcp_service_account" {
  value = google_service_account.api.email
}

output "ingress_ip" {
  value = google_compute_global_address.ingress.address
}

output "assets_bucket" {
  value = google_storage_bucket.assets.name
}
