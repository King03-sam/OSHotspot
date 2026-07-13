# Fish completion for oshotspot

# Main commands
complete -c oshotspot -f
complete -c oshotspot -n "__fish_use_subcommand" -a start -d "Start the WiFi hotspot"
complete -c oshotspot -n "__fish_use_subcommand" -a stop -d "Stop the WiFi hotspot"
complete -c oshotspot -n "__fish_use_subcommand" -a restart -d "Stop and start the hotspot"
complete -c oshotspot -n "__fish_use_subcommand" -a repair -d "Repair hotspot after suspend/resume"
complete -c oshotspot -n "__fish_use_subcommand" -a status -d "Show hotspot status"
complete -c oshotspot -n "__fish_use_subcommand" -a clients -d "Show connected clients"
complete -c oshotspot -n "__fish_use_subcommand" -a monitor -d "Real-time monitoring"
complete -c oshotspot -n "__fish_use_subcommand" -a config -d "Show current configuration"
complete -c oshotspot -n "__fish_use_subcommand" -a qr -d "Show QR code to connect phone"
complete -c oshotspot -n "__fish_use_subcommand" -a doctor -d "Run diagnostic checks"
complete -c oshotspot -n "__fish_use_subcommand" -a interfaces -d "List available WiFi interfaces"
complete -c oshotspot -n "__fish_use_subcommand" -a logs -d "View and follow hotspot logs"
complete -c oshotspot -n "__fish_use_subcommand" -a enable -d "Enable hotspot at boot"
complete -c oshotspot -n "__fish_use_subcommand" -a disable -d "Disable hotspot at boot"
complete -c oshotspot -n "__fish_use_subcommand" -a set -d "Change configuration setting"
complete -c oshotspot -n "__fish_use_subcommand" -a help -d "Show help message"

# set subcommand options
complete -c oshotspot -n "__fish_seen_subcommand_from set" -a ssid -d "Change hotspot name"
complete -c oshotspot -n "__fish_seen_subcommand_from set" -a password -d "Change hotspot password"
complete -c oshotspot -n "__fish_seen_subcommand_from set" -a wifi_iface -d "Choose WiFi interface"

# logs subcommand options
complete -c oshotspot -n "__fish_seen_subcommand_from logs" -a hostapd -d "Show hostapd log only"
complete -c oshotspot -n "__fish_seen_subcommand_from logs" -a dnsmasq -d "Show dnsmasq log only"
complete -c oshotspot -n "__fish_seen_subcommand_from logs" -a all -d "Show both logs"
complete -c oshotspot -n "__fish_seen_subcommand_from logs" -l follow -s f -d "Follow log output"
complete -c oshotspot -n "__fish_seen_subcommand_from logs" -l lines -d "Number of lines to show"
