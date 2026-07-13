#compdef oshotspot

# Zsh completion for oshotspot

_oshotspot() {
    local -a commands
    commands=(
        'start:Start the WiFi hotspot'
        'stop:Stop the WiFi hotspot'
        'restart:Stop and start the hotspot'
        'repair:Repair hotspot after suspend/resume'
        'status:Show hotspot status'
        'clients:Show connected clients'
        'monitor:Real-time monitoring'
        'config:Show current configuration'
        'qr:Show QR code to connect phone'
        'doctor:Run diagnostic checks'
'interfaces:List available WiFi interfaces'
'logs:View and follow hotspot logs'
'web:Launch web dashboard in browser'
'enable:Enable hotspot at boot'
        'disable:Disable hotspot at boot'
        'set:Change configuration setting'
        'help:Show help message'
    )

    local -a set_options
    set_options=(
        'ssid:Change hotspot name'
        'password:Change hotspot password'
        'wifi_iface:Choose WiFi interface for internet'
    )

    local -a log_components
    log_components=(
        'hostapd:Show hostapd log only'
        'dnsmasq:Show dnsmasq log only'
        'all:Show both logs'
    )

    _arguments -C \
        '1:command:->command' \
        '*::arg:->args'

    case $state in
        command)
            _describe 'command' commands
            ;;
        args)
            case $words[1] in
                set)
                    _describe 'setting' set_options
                    ;;
                logs)
                    _alternative \
                        'components:component:((hostapd\:"Show hostapd log" dnsmasq\:"Show dnsmasq log" all\:"Show both logs"))' \
                        'options:option:((--follow\:"Follow log output" --lines\:"Number of lines"))'
                    ;;
                *)
                    ;;
            esac
            ;;
    esac
}

_oshotspot "$@"
