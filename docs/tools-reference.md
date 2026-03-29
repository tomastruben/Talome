# Talome MCP Tools Reference

The MCP server auto-syncs from `allTools` in `apps/core/src/ai/agent.ts` — every tool the dashboard assistant has is also available here.

## Docker
- `list_containers` — list all containers with status, ports, images
- `get_container_logs` — logs from a specific container
- `start_container` / `stop_container` / `restart_container` — lifecycle control
- `check_service_health` — health check with resource usage stats
- `inspect_container` — detailed container info (restart count, state, mounts, labels)
- `get_container_stats` — real-time CPU, memory, and network stats for a container
- `list_images` — list all Docker images with tags and sizes
- `list_networks` — list Docker networks with drivers and connected containers
- `prune_resources` — remove unused containers, images, volumes, or networks
- `exec_container` — execute a command inside a running container

## System
- `get_system_stats` — CPU, memory, disk, network usage
- `get_disk_usage` — disk usage per mounted filesystem
- `get_system_health` — overall health summary

## Apps
- `list_apps` — installed apps and their status
- `search_apps` — search the catalog (Talome, CasaOS, Umbrel, My Creations)
- `install_app` / `uninstall_app` / `start_app` / `stop_app` / `restart_app` / `update_app` — lifecycle
- `add_store` — add a new app store source by Git URL

## Media
- `get_library` — all TV shows and movies in Sonarr/Radarr
- `search_media` — search for new content to add (returns tvdbId / tmdbId)
- `get_downloads` — download queue from qBittorrent + Sonarr/Radarr
- `get_calendar` — upcoming episodes and movie releases (next 14 days)
- `request_media` — add a show/movie to Sonarr/Radarr for downloading

## Arr (Sonarr / Radarr / Prowlarr)
- `arr_get_status` — health and version info
- `arr_list_root_folders` / `arr_add_root_folder` — media library paths
- `arr_list_download_clients` / `arr_add_download_client` / `arr_test_download_client`
- `arr_list_indexers` / `arr_sync_indexers_from_prowlarr`
- `arr_list_quality_profiles` / `arr_apply_quality_profile`
- `arr_get_wanted_missing` / `arr_get_wanted_cutoff` — backlog
- `arr_search_releases` / `arr_grab_release` — manual searching
- `arr_get_queue_details` / `arr_queue_action` / `arr_delete_queue_item` / `arr_cleanup_dry_run`
- `arr_get_history` — view grab/import/failure history for debugging
- `arr_run_command` — trigger actions (RefreshSeries, MissingEpisodeSearch, RssSync, Backup, RenameFiles, etc.)
- `arr_manage_blocklist` — view/delete/clear blocklisted releases
- `arr_mark_failed` — mark a history item as failed to trigger re-search
- `arr_set_monitoring` — change series/movie/episode monitoring (including monitorNewItems for new seasons)
- `arr_set_naming_convention`
- `prowlarr_search` — cross-indexer search (Prowlarr's key feature)
- `prowlarr_manage_indexers` — add/update/delete/test indexers, list available schemas
- `prowlarr_get_indexer_stats` — per-indexer performance stats (queries, grabs, response times)

## qBittorrent
- `qbt_get_version` / `qbt_get_preferences` / `qbt_set_preferences`
- `qbt_set_download_path` / `qbt_set_speed_limits` / `qbt_list_torrents`

## Jellyfin
- `jellyfin_get_status` / `jellyfin_list_libraries` / `jellyfin_add_library`
- `jellyfin_scan_library` / `jellyfin_get_stats` / `jellyfin_create_api_key`

## Overseerr
- `overseerr_get_status` / `overseerr_configure_jellyfin` / `overseerr_configure_sonarr` / `overseerr_configure_radarr`
- `overseerr_list_requests` / `overseerr_approve_request`

## Home Assistant
- `hass_get_status` / `hass_list_entities` / `hass_call_service` / `hass_get_history` / `hass_create_automation`

## Pi-hole
- `pihole_get_stats` / `pihole_enable` / `pihole_disable` / `pihole_whitelist` / `pihole_blacklist`

## Vaultwarden
- `vaultwarden_get_status` / `vaultwarden_invite_user` / `vaultwarden_list_users` / `vaultwarden_toggle_signups`

## Compose & Config
- `get_app_config` / `set_app_env` / `change_port_mapping` / `add_volume_mount` / `set_resource_limits` / `upgrade_app_image`
- `read_app_config_file` / `write_app_config_file` / `list_app_config_files`
- `diagnose_app`

## Universal App Interaction
- `app_api_call` — make HTTP API calls to any installed app (auth auto-detected from app-registry)
- `discover_app_api` — probe an app's API surface to find available endpoints
- `test_app_connectivity` — verify network connectivity between two apps
- `wire_apps` — auto-configure connections between related apps

## Backup & Restore
- `backup_app` — create tarball backup of app data volumes
- `restore_app` — restore app data from a backup archive

## Log Search
- `search_container_logs` — cross-container log search with regex pattern matching

## Filesystem
- `run_shell` — run shell commands on the host
- `read_file` / `list_directory` / `rollback_file`

## Widgets & Automations
- `list_widgets` / `create_widget_manifest` / `update_widget_manifest`
- `list_automations` / `create_automation` / `update_automation` / `delete_automation`
- `get_automation_runs` — run history with per-step results
- `validate_cron` — validate cron expressions and show next fire times
- `list_automation_safe_tools` — show which tools are available in automations

## Memories
- `remember` / `recall` / `forget`
- `update_memory` — update an existing memory in-place by ID
- `list_memories` — list all memories with optional type filtering

## Settings & Configuration
- `get_settings` — read one or all Talome settings
- `set_setting` — create or update a setting (e.g. sonarr_url, api keys)
- `list_configured_apps` — show which app domains are active based on settings

## Notifications
- `send_notification` — send info/warning/critical notification to dashboard
- `get_notifications` — read recent notifications (unread filter)

## Self-improvement
- `plan_change` / `apply_change` / `rollback_change` / `list_changes`

## App creation
- `create_app_from_description` — generate a new app scaffold
