/*
 * OSHotspot
 * Copyright 2026 OLOJEDE Samuel
 *
 * Licensed under the Apache License, Version 2.0
 */

#ifndef OSHOTSPOT_H
#define OSHOTSPOT_H

#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>

/* WiFi capabilities scanned via nl80211 */
struct wifi_caps {
    bool supports_ap;
    bool supports_ht;
    bool supports_vht;
    bool supports_short_gi_20;
    bool supports_short_gi_40;
    int  max_sta;
    int  channel_2g[14];
    int  channel_2g_count;
    int  channel_5g[64];
    int  channel_5g_count;
    char phy[16];
    char iface[16];
};

/* User configuration from config.conf */
struct user_config {
    char ssid[34];
    char password[64];
    int  channel;
    char hw_mode[4];
    char country_code[4];
    char ap_iface[16];
    char ap_ip[16];
    char dns_primary[16];
    char dns_secondary[16];
    int  dhcp_range_start;
    int  dhcp_range_end;
    char dhcp_lease[8];
};

/* Process status for watchdog */
struct proc_status {
    pid_t pid;
    bool  running;
    int   restart_count;
    char  name[32];
    char  pid_file[128];
};

/* JSON output helpers */
#define JSON_STR(key, val)  fprintf(stdout, "  \"%s\": \"%s\",\n", key, val)
#define JSON_BOOL(key, val) fprintf(stdout, "  \"%s\": %s,\n", key, (val) ? "true" : "false")
#define JSON_INT(key, val)  fprintf(stdout, "  \"%s\": %d,\n", key, val)
#define JSON_ARR_START(key) fprintf(stdout, "  \"%s\": [", key)
#define JSON_ARR_END()      fprintf(stdout, "]\n")
#define JSON_OBJ_START()    fprintf(stdout, "{\n")
#define JSON_OBJ_END()      fprintf(stdout, "}\n")

/* Scan WiFi capabilities via nl80211 */
int wifi_scan(const char *phy_or_iface, struct wifi_caps *caps);

/* Parse JSON capabilities string */
int parse_caps_json(const char *json, struct wifi_caps *caps);

/* Generate adaptive hostapd.conf */
void generate_hostapd_conf(const struct wifi_caps *caps,
                           const struct user_config *cfg,
                           const char *output_path);

/* Watchdog: check and restart crashed processes */
int watchdog_check(void);
int watchdog_monitor(int interval_sec);

#endif /* OSHOTSPOT_H */
