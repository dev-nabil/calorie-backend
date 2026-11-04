# Cloudflare in front of every public host name (DEC-17): DNS + proxy, managed WAF, edge rate limits
# for auth and AI routes, and the private R2 bucket for photos and pre-rendered audio (DEC-08).

resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.api_hostname
  type    = "CNAME"
  content = "ghs.googlehosted.com"
  proxied = true
  ttl     = 1
  comment = "Nouri API (${var.environment}) → Cloud Run domain mapping"
}

# Cloudflare Managed Ruleset and OWASP Core Ruleset (managed ids are stable across zones).
resource "cloudflare_ruleset" "waf_managed" {
  zone_id     = var.cloudflare_zone_id
  name        = "nouri-${var.environment}-managed-waf"
  description = "Managed WAF rules"
  kind        = "zone"
  phase       = "http_request_firewall_managed"
  rules = [
    {
      description       = "Cloudflare Managed Ruleset"
      expression        = "true"
      action            = "execute"
      enabled           = true
      action_parameters = { id = "efb7b8c949ac4650a09736fc376e9aee" }
    },
    {
      description       = "Cloudflare OWASP Core Ruleset"
      expression        = "true"
      action            = "execute"
      enabled           = true
      action_parameters = { id = "4814384a9e5d4991b9815dcfc25d2f1f" }
    },
  ]
}

# Edge rate limits (the API also limits per user, device and IP). Plan section 7 classes: auth, ai.
resource "cloudflare_ruleset" "rate_limits" {
  zone_id     = var.cloudflare_zone_id
  name        = "nouri-${var.environment}-rate-limits"
  description = "Edge rate limits for auth and AI routes"
  kind        = "zone"
  phase       = "http_ratelimit"
  rules = [
    {
      description = "Auth endpoints"
      expression  = "(http.host eq \"${var.api_hostname}\" and starts_with(http.request.uri.path, \"/v1/auth/\"))"
      action      = "block"
      enabled     = true
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.auth_rate_limit_per_minute
        mitigation_timeout  = 600
      }
    },
    {
      description = "AI endpoints (scans, meal parse, conversation turns, speech)"
      expression  = "(http.host eq \"${var.api_hostname}\" and http.request.method eq \"POST\" and (starts_with(http.request.uri.path, \"/v1/scans\") or http.request.uri.path eq \"/v1/meals/parse\" or (starts_with(http.request.uri.path, \"/v1/conversations/\") and ends_with(http.request.uri.path, \"/turns\")) or http.request.uri.path eq \"/v1/voice/speech\"))"
      action      = "block"
      enabled     = true
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.ai_rate_limit_per_minute
        mitigation_timeout  = 300
      }
    },
  ]
}

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "nouri-${var.environment}-media"
  location   = var.r2_location
}
