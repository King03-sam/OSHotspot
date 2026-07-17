/*
 * OSHotspot
 * Copyright 2026 OLOJEDE Samuel
 *
 * Licensed under the Apache License, Version 2.0
 *
 * oshotspot-gen - Adaptive hostapd config generator
 *
 * Usage:
 *   oshotspot-scan --phy=phy0 | oshotspot-gen --config=config.conf
 *   oshotspot-gen --caps=caps.json --config=config.conf --output=hostapd.conf
 *
 * Generates hostapd.conf adapted to actual hardware capabilities.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#include "oshotspot.h"

/* Default values */
#define DEFAULT_SSID           "OSHotspot"
#define DEFAULT_PASSWORD       "ChangeMe123"
#define DEFAULT_CHANNEL        6
#define DEFAULT_HW_MODE        "g"
#define DEFAULT_COUNTRY_CODE   "FR"
#define DEFAULT_AP_IFACE       "ap0"
#define DEFAULT_AP_IP          "192.168.50.1"
#define DEFAULT_DNS_PRIMARY    "8.8.8.8"
#define DEFAULT_DNS_SECONDARY  "1.1.1.1"
#define DEFAULT_DHCP_START     10
#define DEFAULT_DHCP_END       100
#define DEFAULT_DHCP_LEASE     "12h"

/* Read entire file into buffer */
static char *read_file(const char *path)
{
    FILE *f;
    long  len;
    char *buf;

    f = fopen(path, "r");
    if (!f)
        return NULL;

    fseek(f, 0, SEEK_END);
    len = ftell(f);
    fseek(f, 0, SEEK_SET);

    buf = malloc(len + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }

    if (fread(buf, 1, len, f) < (size_t)len) {
        /* Short read is OK, we null-terminate anyway */
    }
    buf[len] = '\0';
    fclose(f);

    return buf;
}

/* Extract value for KEY from shell-sourced config file */
static int get_config_value(const char *content, const char *key,
                            char *out, size_t out_len)
{
    const char *start;
    const char *end;
    size_t key_len;

    key_len = strlen(key);

    /* Find KEY= pattern */
    start = content;
    while ((start = strstr(start, key)) != NULL) {
        /* Check it starts at line beginning or after whitespace */
        if (start != content && *(start - 1) != '\n' && !isspace(*(start - 1))) {
            start += key_len;
            continue;
        }

        /* Check next char is = */
        if (start[key_len] != '=') {
            start += key_len;
            continue;
        }

        /* Found KEY= */
        start += key_len + 1; /* skip KEY= */

        /* Skip opening quote if present */
        if (*start == '"')
            start++;

        /* Find end of value */
        end = start;
        while (*end && *end != '\n' && *end != '"')
            end++;

        /* Copy value */
        if ((size_t)(end - start) >= out_len)
            return -1;

        memcpy(out, start, end - start);
        out[end - start] = '\0';
        return 0;
    }

    return -1;
}

/* Parse user config from file */
static void parse_user_config(const char *path, struct user_config *cfg)
{
    char *content;
    char buf[256];

    /* Set defaults */
    strncpy(cfg->ssid, DEFAULT_SSID, sizeof(cfg->ssid) - 1);
    strncpy(cfg->password, DEFAULT_PASSWORD, sizeof(cfg->password) - 1);
    cfg->channel = DEFAULT_CHANNEL;
    strncpy(cfg->hw_mode, DEFAULT_HW_MODE, sizeof(cfg->hw_mode) - 1);
    strncpy(cfg->country_code, DEFAULT_COUNTRY_CODE, sizeof(cfg->country_code) - 1);
    strncpy(cfg->ap_iface, DEFAULT_AP_IFACE, sizeof(cfg->ap_iface) - 1);
    strncpy(cfg->ap_ip, DEFAULT_AP_IP, sizeof(cfg->ap_ip) - 1);
    strncpy(cfg->dns_primary, DEFAULT_DNS_PRIMARY, sizeof(cfg->dns_primary) - 1);
    strncpy(cfg->dns_secondary, DEFAULT_DNS_SECONDARY, sizeof(cfg->dns_secondary) - 1);
    cfg->dhcp_range_start = DEFAULT_DHCP_START;
    cfg->dhcp_range_end = DEFAULT_DHCP_END;
    strncpy(cfg->dhcp_lease, DEFAULT_DHCP_LEASE, sizeof(cfg->dhcp_lease) - 1);

    if (!path)
        return;

    content = read_file(path);
    if (!content)
        return;

    if (get_config_value(content, "SSID", buf, sizeof(buf)) == 0)
        strncpy(cfg->ssid, buf, sizeof(cfg->ssid) - 1);

    if (get_config_value(content, "PASSWORD", buf, sizeof(buf)) == 0)
        strncpy(cfg->password, buf, sizeof(cfg->password) - 1);

    if (get_config_value(content, "CHANNEL", buf, sizeof(buf)) == 0)
        cfg->channel = atoi(buf);

    if (get_config_value(content, "HW_MODE", buf, sizeof(buf)) == 0)
        strncpy(cfg->hw_mode, buf, sizeof(cfg->hw_mode) - 1);

    if (get_config_value(content, "COUNTRY_CODE", buf, sizeof(buf)) == 0)
        strncpy(cfg->country_code, buf, sizeof(cfg->country_code) - 1);

    if (get_config_value(content, "AP_IFACE", buf, sizeof(buf)) == 0)
        strncpy(cfg->ap_iface, buf, sizeof(cfg->ap_iface) - 1);

    if (get_config_value(content, "AP_IP", buf, sizeof(buf)) == 0)
        strncpy(cfg->ap_ip, buf, sizeof(cfg->ap_ip) - 1);

    if (get_config_value(content, "DNS_PRIMARY", buf, sizeof(buf)) == 0)
        strncpy(cfg->dns_primary, buf, sizeof(cfg->dns_primary) - 1);

    if (get_config_value(content, "DNS_SECONDARY", buf, sizeof(buf)) == 0)
        strncpy(cfg->dns_secondary, buf, sizeof(cfg->dns_secondary) - 1);

    if (get_config_value(content, "DHCP_RANGE_START", buf, sizeof(buf)) == 0)
        cfg->dhcp_range_start = atoi(buf);

    if (get_config_value(content, "DHCP_RANGE_END", buf, sizeof(buf)) == 0)
        cfg->dhcp_range_end = atoi(buf);

    if (get_config_value(content, "DHCP_LEASE", buf, sizeof(buf)) == 0)
        strncpy(cfg->dhcp_lease, buf, sizeof(cfg->dhcp_lease) - 1);

    free(content);
}

/* Check if a channel is in the supported list */
static bool channel_supported(const struct wifi_caps *caps, int channel)
{
    int i;

    /* Check 2.4 GHz channels */
    for (i = 0; i < caps->channel_2g_count; i++) {
        if (caps->channel_2g[i] == channel)
            return true;
    }

    /* Check 5 GHz channels */
    for (i = 0; i < caps->channel_5g_count; i++) {
        if (caps->channel_5g[i] == channel)
            return true;
    }

    return false;
}

/* Find best available channel */
static int find_best_channel(const struct wifi_caps *caps, const char *hw_mode)
{
    int i;

    if (strcmp(hw_mode, "a") == 0) {
        /* 5 GHz: prefer channel 36 or first available */
        for (i = 0; i < caps->channel_5g_count; i++) {
            if (caps->channel_5g[i] == 36)
                return 36;
        }
        if (caps->channel_5g_count > 0)
            return caps->channel_5g[0];
    }

    /* 2.4 GHz: prefer channel 6 or first available */
    for (i = 0; i < caps->channel_2g_count; i++) {
        if (caps->channel_2g[i] == 6)
            return 6;
    }
    if (caps->channel_2g_count > 0)
        return caps->channel_2g[0];

    return 6; /* fallback */
}

/* Generate adaptive hostapd.conf */
void generate_hostapd_conf(const struct wifi_caps *caps,
                           const struct user_config *cfg,
                           const char *output_path)
{
    FILE *f;
    int   channel;
    const char *hw_mode;

    f = fopen(output_path, "w");
    if (!f) {
        fprintf(stderr, "Error: cannot write to %s\n", output_path);
        return;
    }

    /* Determine hw_mode based on capabilities */
    hw_mode = cfg->hw_mode;

    /* If user wants 5GHz but adapter doesn't support it, fallback to 2.4GHz */
    if (strcmp(hw_mode, "a") == 0 && caps->channel_5g_count == 0) {
        fprintf(stderr, "Warning: 5GHz not supported, falling back to 2.4GHz\n");
        hw_mode = "g";
    }

    /* Determine channel */
    channel = cfg->channel;

    /* If selected channel is not supported, find best alternative */
    if (!channel_supported(caps, channel)) {
        fprintf(stderr, "Warning: channel %d not supported, selecting best available\n",
                channel);
        channel = find_best_channel(caps, hw_mode);
    }

    /* Write hostapd.conf */
    fprintf(f, "#\n");
    fprintf(f, "# OSHotspot - Adaptive hostapd configuration\n");
    fprintf(f, "# Generated by oshotspot-gen\n");
    fprintf(f, "# Hardware: %s | AP=%s | HT=%s | SHORT-GI-20=%s\n",
            caps->phy,
            caps->supports_ap ? "yes" : "no",
            caps->supports_ht ? "yes" : "no",
            caps->supports_short_gi_20 ? "yes" : "no");
    fprintf(f, "#\n\n");

    fprintf(f, "ctrl_interface=/var/run/hostapd\n");
    fprintf(f, "ctrl_interface_group=0\n\n");

    fprintf(f, "interface=%s\n", cfg->ap_iface);
    fprintf(f, "driver=nl80211\n");
    fprintf(f, "ssid=%s\n", cfg->ssid);
    fprintf(f, "hw_mode=%s\n", hw_mode);
    fprintf(f, "channel=%d\n", channel);
    fprintf(f, "country_code=%s\n\n", cfg->country_code);

    /* 802.11n settings - only if HT is supported */
    if (caps->supports_ht) {
        fprintf(f, "ieee80211n=1\n");
        fprintf(f, "wmm_enabled=1\n");
        fprintf(f, "ht_capab=[HT20]");

        /* Only add SHORT-GI if actually supported */
        if (caps->supports_short_gi_20)
            fprintf(f, "[SHORT-GI-20]");

        fprintf(f, "\n\n");
    }

    fprintf(f, "beacon_int=100\n");
    fprintf(f, "dtim_period=2\n\n");

    fprintf(f, "auth_algs=1\n");
    fprintf(f, "wpa=2\n");
    fprintf(f, "wpa_passphrase=%s\n", cfg->password);
    fprintf(f, "wpa_key_mgmt=WPA-PSK\n");
    fprintf(f, "rsn_pairwise=CCMP\n\n");

    fprintf(f, "macaddr_acl=0\n");
    fprintf(f, "deny_mac_file=/etc/oshotspot/deny_maclist.conf\n");

    fclose(f);

    /* Ensure deny_maclist.conf exists for hostapd */
    {
        FILE *df = fopen("/etc/oshotspot/deny_maclist.conf", "a");
        if (df) fclose(df);
    }

    fprintf(stderr, "Hostapd config written to %s\n", output_path);
    fprintf(stderr, "  HW mode: %s | Channel: %d | HT: %s | SHORT-GI-20: %s\n",
            hw_mode, channel,
            caps->supports_ht ? "enabled" : "disabled",
            caps->supports_short_gi_20 ? "enabled" : "disabled");
}

/* Parse JSON integer array: "key": [1,2,3,...] */
static int parse_json_int_array(const char *json, const char *key,
                                int *out, int max)
{
    char search[128];
    const char *p;
    int count = 0;

    snprintf(search, sizeof(search), "\"%s\":", key);
    p = strstr(json, search);
    if (!p)
        return 0;

    p = strchr(p, '[');
    if (!p)
        return 0;
    p++;

    while (*p && *p != ']' && count < max) {
        while (*p == ' ' || *p == ',') p++;
        if (*p == ']' || !*p)
            break;
        out[count++] = atoi(p);
        while (*p && *p != ',' && *p != ']')
            p++;
    }
    return count;
}

/* Parse JSON capabilities (simplified parser) */
static int parse_json_bool(const char *json, const char *key)
{
    char search[128];
    const char *p;

    snprintf(search, sizeof(search), "\"%s\":", key);
    p = strstr(json, search);
    if (!p)
        return -1;

    p += strlen(search);
    while (*p == ' ') p++;

    if (strncmp(p, "true", 4) == 0) return 1;
    if (strncmp(p, "false", 5) == 0) return 0;
    return -1;
}

int parse_caps_json(const char *json, struct wifi_caps *caps)
{
    int val;

    val = parse_json_bool(json, "supports_ap");
    if (val >= 0) caps->supports_ap = (val == 1);

    val = parse_json_bool(json, "supports_ht");
    if (val >= 0) caps->supports_ht = (val == 1);

    val = parse_json_bool(json, "supports_vht");
    if (val >= 0) caps->supports_vht = (val == 1);

    val = parse_json_bool(json, "supports_short_gi_20");
    if (val >= 0) caps->supports_short_gi_20 = (val == 1);

    val = parse_json_bool(json, "supports_short_gi_40");
    if (val >= 0) caps->supports_short_gi_40 = (val == 1);

    caps->channel_2g_count = parse_json_int_array(json, "channels_2g",
                                                   caps->channel_2g, 14);
    caps->channel_5g_count = parse_json_int_array(json, "channels_5g",
                                                   caps->channel_5g, 64);

    return 0;
}

/* Print usage information */
static void usage(const char *prog)
{
    fprintf(stderr, "Usage:\n");
    fprintf(stderr, "  %s --caps=<file> --config=<file> [--output=<file>]\n", prog);
    fprintf(stderr, "  oshotspot-scan --phy=phy0 | %s --config=<file>\n", prog);
    fprintf(stderr, "\nGenerate adaptive hostapd.conf based on hardware capabilities.\n");
    fprintf(stderr, "\nOptions:\n");
    fprintf(stderr, "  --caps=<file>     JSON file from oshotspot-scan (or stdin)\n");
    fprintf(stderr, "  --config=<file>   OSHotspot config.conf file\n");
    fprintf(stderr, "  --output=<file>   Output hostapd.conf (default: /etc/oshotspot/hostapd.conf)\n");
    fprintf(stderr, "  -h, --help        Show this help\n");
}

int main(int argc, char *argv[])
{
    struct wifi_caps caps;
    struct user_config cfg;
    const char *caps_file = NULL;
    const char *config_file = NULL;
    const char *output_file = "/etc/oshotspot/hostapd.conf";
    char *caps_json = NULL;
    int i;

    for (i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--caps=", 7) == 0) {
            caps_file = argv[i] + 7;
        } else if (strncmp(argv[i], "--config=", 9) == 0) {
            config_file = argv[i] + 9;
        } else if (strncmp(argv[i], "--output=", 9) == 0) {
            output_file = argv[i] + 9;
        } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "Error: unknown option '%s'\n", argv[i]);
            usage(argv[0]);
            return 1;
        }
    }

    /* Initialize */
    memset(&caps, 0, sizeof(caps));
    memset(&cfg, 0, sizeof(cfg));

    /* Set reasonable defaults for capabilities if not provided */
    caps.supports_ap = true;
    caps.supports_ht = true;
    caps.supports_short_gi_20 = true;

    /* Read capabilities from file or stdin */
    if (caps_file) {
        caps_json = read_file(caps_file);
        if (!caps_json) {
            fprintf(stderr, "Error: cannot read caps file %s\n", caps_file);
            return 1;
        }
        parse_caps_json(caps_json, &caps);
        free(caps_json);
    } else {
        /* Try to read from stdin */
        char buf[4096];
        size_t total = 0;
        size_t n;

        while ((n = fread(buf + total, 1, sizeof(buf) - total - 1, stdin)) > 0)
            total += n;

        if (total > 0) {
            buf[total] = '\0';
            parse_caps_json(buf, &caps);
        }
    }

    /* Parse user config */
    parse_user_config(config_file, &cfg);

    /* Generate config */
    generate_hostapd_conf(&caps, &cfg, output_file);

    return 0;
}
