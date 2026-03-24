# =============================================================================
# Discord Bot Worker
# =============================================================================

resource "null_resource" "discord_bot_build" {
  count = var.enable_discord_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/discord-bot"
  }
}

module "discord_bot_worker" {
  count  = var.enable_discord_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-discord-bot-${local.name_suffix}"
  script_path = local.discord_bot_script_path

  kv_namespaces = [
    {
      binding_name = "DISCORD_KV"
      namespace_id = module.discord_kv[0].namespace_id
    }
  ]

  service_bindings = [
    {
      binding_name = "CONTROL_PLANE"
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "CONTROL_PLANE_URL", value = local.control_plane_url },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "DEFAULT_MODEL", value = "claude-haiku-4-5" },
    { name = "CLASSIFICATION_MODEL", value = "claude-haiku-4-5" },
    { name = "DISCORD_APPLICATION_ID", value = var.discord_application_id },
  ]

  secrets = [
    { name = "DISCORD_PUBLIC_KEY", value = var.discord_public_key },
    { name = "DISCORD_BOT_TOKEN", value = var.discord_bot_token },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.discord_bot_build[0], module.discord_kv[0]]
}
