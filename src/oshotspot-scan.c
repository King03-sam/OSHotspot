/*
 * OSHotspot
 * Copyright 2026 OLOJEDE Samuel
 *
 * Licensed under the Apache License, Version 2.0
 *
 * oshotspot-scan - WiFi adapter capability scanner via nl80211
 *
 * Usage:
 *   oshotspot-scan --phy=phy0
 *   oshotspot-scan --iface=wlp2s0
 *
 * Output: JSON with adapter capabilities
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <net/if.h>
#include <linux/netlink.h>
#include <netlink/netlink.h>
#include <netlink/genl/genl.h>
#include <netlink/genl/ctrl.h>
#include <netlink/handlers.h>
#include <linux/nl80211.h>



#include "oshotspot.h"

/* Callback context for nl80211 messages */
struct scan_ctx {
    struct wifi_caps *caps;
    int              wiphy_id;
    bool             got_wiphy;
    bool             done;   /* set once the multi-message dump finishes */
    int              error;  /* netlink error code, if any */
};

/* Parse a single nl80211 attribute for interface modes */
static int parse_iface_modes(struct nlattr *tb,
                             struct scan_ctx *ctx)
{
    struct nlattr *nl_mode;
    int rem;

    if (!tb)
        return 0;

    nla_for_each_nested(nl_mode, tb, rem) {
        uint32_t mode = nla_get_u32(nl_mode);

        switch (mode) {
        case NL80211_IFTYPE_AP:
            ctx->caps->supports_ap = true;
            break;
        default:
            break;
        }
    }
    return 0;
}

/* Parse HT capabilities */
static int parse_ht_cap(struct nlattr *tb,
                        struct scan_ctx *ctx)
{
    struct nlattr *nl_ht;
    int rem;

    if (!tb)
        return 0;

    ctx->caps->supports_ht = true;

    nla_for_each_nested(nl_ht, tb, rem) {
        uint32_t cap = nla_get_u32(nl_ht);

        /* Check for SHORT-GI-20 (bit 5) */
        if (cap & (1 << 5))
            ctx->caps->supports_short_gi_20 = true;

        /* Check for SHORT-GI-40 (bit 6) */
        if (cap & (1 << 6))
            ctx->caps->supports_short_gi_40 = true;
    }
    return 0;
}

/* Parse frequency bands and extract channels */
static int parse_bands(struct nlattr *tb,
                       struct scan_ctx *ctx)
{
    struct nlattr *nl_band;
    int rem;

    if (!tb)
        return 0;

    nla_for_each_nested(nl_band, tb, rem) {
        struct nlattr *nl_freq;
        int freq_rem;

        /* Each band has a list of frequencies */
        nla_for_each_nested(nl_freq, nl_band, freq_rem) {
            struct nlattr *nl_freq_attr[NL80211_FREQUENCY_ATTR_MAX + 1];
            struct nlattr *nl_freq_info;
            uint32_t freq;
            int channel;

            nla_parse(nl_freq_attr, NL80211_FREQUENCY_ATTR_MAX,
                      nla_data(nl_freq), nla_len(nl_freq), NULL);

            nl_freq_info = nl_freq_attr[NL80211_FREQUENCY_ATTR_FREQ];
            if (!nl_freq_info)
                continue;

            freq = nla_get_u32(nl_freq_info);

            /* Convert frequency to channel number */
            if (freq >= 2412 && freq <= 2484) {
                /* 2.4 GHz band */
                channel = (freq - 2407) / 5;
                if (channel >= 1 && channel <= 13 &&
                    ctx->caps->channel_2g_count < 14) {
                    ctx->caps->channel_2g[ctx->caps->channel_2g_count++] = channel;
                }
            } else if (freq >= 5170 && freq <= 5825) {
                /* 5 GHz band */
                channel = (freq - 5000) / 5;
                if (channel >= 1 && channel <= 165 &&
                    ctx->caps->channel_5g_count < 64) {
                    ctx->caps->channel_5g[ctx->caps->channel_5g_count++] = channel;
                }
            }
        }
    }
    return 0;
}

/* Parse VHT capabilities */
static int parse_vht_cap(struct nlattr *tb,
                         struct scan_ctx *ctx)
{
    if (tb)
        ctx->caps->supports_vht = true;
    return 0;
}


static int finish_handler(struct nl_msg *msg, void *arg)
{
    struct scan_ctx *ctx = arg;
    (void)msg;
    ctx->done = true;
    return NL_SKIP;
}

static int ack_handler(struct nl_msg *msg, void *arg)
{
    struct scan_ctx *ctx = arg;
    (void)msg;
    ctx->done = true;
    return NL_STOP;
}

static int error_handler(struct sockaddr_nl *nla, struct nlmsgerr *nlerr, void *arg)
{
    struct scan_ctx *ctx = arg;
    (void)nla;
    ctx->error = nlerr ? nlerr->error : -1;
    ctx->done = true;
    return NL_STOP;
}

/* Callback for NL80211_CMD_GET_WIPHY responses */
static int wiphy_handler(struct nl_msg *msg, void *arg)
{
    struct scan_ctx *ctx = arg;
    struct genlmsghdr *gnlh = nlmsg_data(nlmsg_hdr(msg));
    struct nlattr *tb[NL80211_ATTR_MAX + 1];

    nla_parse(tb, NL80211_ATTR_MAX,
              genlmsg_attrdata(gnlh, 0),
              genlmsg_attrlen(gnlh, 0), NULL);

    /* Get wiphy index */
    if (tb[NL80211_ATTR_WIPHY]) {
        ctx->wiphy_id = nla_get_u32(tb[NL80211_ATTR_WIPHY]);
        ctx->got_wiphy = true;
    }

    /* Parse supported interface types */
    if (tb[NL80211_ATTR_SUPPORTED_IFTYPES])
        parse_iface_modes(tb[NL80211_ATTR_SUPPORTED_IFTYPES], ctx);

    /* Parse HT capabilities */
    if (tb[NL80211_ATTR_WIPHY_BANDS]) {
        struct nlattr *band;
        int rem;

        nla_for_each_nested(band, tb[NL80211_ATTR_WIPHY_BANDS], rem) {
            struct nlattr *nl_band[NL80211_BAND_ATTR_MAX + 1];
            nla_parse(nl_band, NL80211_BAND_ATTR_MAX,
                      nla_data(band), nla_len(band), NULL);

            if (nl_band[NL80211_BAND_ATTR_HT_CAPA])
                parse_ht_cap(nl_band[NL80211_BAND_ATTR_HT_CAPA], ctx);

            if (nl_band[NL80211_BAND_ATTR_VHT_CAPA])
                parse_vht_cap(nl_band[NL80211_BAND_ATTR_VHT_CAPA], ctx);

            if (nl_band[NL80211_BAND_ATTR_FREQS])
                parse_bands(nl_band[NL80211_BAND_ATTR_FREQS], ctx);
        }
    }

    return NL_SKIP;
}

/* Resolve phy name from interface name */
static int resolve_phy_from_iface(const char *iface, char *phy_out, size_t phy_len)
{
    char path[256];
    char resolved[256];
    ssize_t len;

    snprintf(path, sizeof(path), "/sys/class/net/%s/phy80211/name", iface);
    len = readlink(path, resolved, sizeof(resolved) - 1);
    if (len < 0) {
        /* Try reading the symlink target */
        FILE *f = fopen(path, "r");
        if (!f)
            return -1;
        if (fgets(resolved, sizeof(resolved), f)) {
            /* Remove trailing newline */
            resolved[strcspn(resolved, "\n")] = '\0';
            strncpy(phy_out, resolved, phy_len - 1);
            phy_out[phy_len - 1] = '\0';
            fclose(f);
            return 0;
        }
        fclose(f);
        return -1;
    }

    resolved[len] = '\0';
    strncpy(phy_out, resolved, phy_len - 1);
    phy_out[phy_len - 1] = '\0';
    return 0;
}

/* Scan WiFi capabilities via nl80211 */
int wifi_scan(const char *phy_or_iface, struct wifi_caps *caps)
{
    struct nl_sock *sock = NULL;
    struct nl_msg  *msg  = NULL;
    struct scan_ctx ctx;
    int driver_id;
    int ret = -1;
    char phy_name[16] = {0};
    bool is_iface = false;

    memset(&ctx, 0, sizeof(ctx));
    ctx.caps = caps;

    /* Determine if input is phy or interface name */
    if (strncmp(phy_or_iface, "phy", 3) == 0) {
        strncpy(phy_name, phy_or_iface, sizeof(phy_name) - 1);
    } else {
        /* It's an interface name, resolve to phy */
        if (resolve_phy_from_iface(phy_or_iface, phy_name, sizeof(phy_name)) < 0) {
            fprintf(stderr, "Error: cannot resolve phy for interface %s\n", phy_or_iface);
            return -1;
        }
        is_iface = true;
    }

    strncpy(caps->phy, phy_name, sizeof(caps->phy) - 1);
    if (is_iface)
        strncpy(caps->iface, phy_or_iface, sizeof(caps->iface) - 1);

    /* Open netlink socket */
    sock = nl_socket_alloc();
    if (!sock) {
        fprintf(stderr, "Error: failed to allocate netlink socket\n");
        return -1;
    }

    if (genl_connect(sock) < 0) {
        fprintf(stderr, "Error: failed to connect netlink socket\n");
        goto cleanup;
    }

    driver_id = genl_ctrl_resolve(sock, "nl80211");
    if (driver_id < 0) {
        fprintf(stderr, "Error: failed to resolve nl80211 family\n");
        goto cleanup;
    }

    /* Allocate and send message */
    msg = nlmsg_alloc();
    if (!msg) {
        fprintf(stderr, "Error: failed to allocate netlink message\n");
        goto cleanup;
    }

    genlmsg_put(msg, 0, 0, driver_id, 0, NLM_F_DUMP,
                NL80211_CMD_GET_WIPHY, 0);

    /* Add split flag for complete dump */
    nla_put_flag(msg, NL80211_ATTR_SPLIT_WIPHY_DUMP);

    /* Set callbacks: one per data message (wiphy_handler), plus the
     * finish/ack/error triplet needed to know when the dump is done. */
    nl_socket_modify_cb(sock, NL_CB_VALID, NL_CB_CUSTOM,
                        wiphy_handler, &ctx);
    nl_socket_modify_cb(sock, NL_CB_FINISH, NL_CB_CUSTOM,
                        finish_handler, &ctx);
    nl_socket_modify_cb(sock, NL_CB_ACK, NL_CB_CUSTOM,
                        ack_handler, &ctx);
    nl_socket_modify_err_cb(sock, NL_CB_CUSTOM,
                        error_handler, &ctx);

    /* Send and receive with 5s timeout */
    ret = nl_send_auto_complete(sock, msg);
    if (ret < 0) {
        fprintf(stderr, "Error: failed to send nl80211 request: %s\n",
                nl_geterror(ret));
        goto cleanup;
    }

  
    {
        int fd = nl_socket_get_fd(sock);
        if (fd < 0) {
            fprintf(stderr, "Error: invalid netlink socket fd\n");
            goto cleanup;
        }

        while (!ctx.done) {
            struct pollfd pfd;
            pfd.fd = fd;
            pfd.events = POLLIN;
            ret = poll(&pfd, 1, 5000); /* 5 second timeout per message */
            if (ret == 0) {
                fprintf(stderr, "Error: nl80211 response timeout (5s)\n");
                goto cleanup;
            } else if (ret < 0) {
                fprintf(stderr, "Error: poll failed: %s\n", strerror(errno));
                goto cleanup;
            }

            ret = nl_recvmsgs_default(sock);
            if (ret < 0) {
                fprintf(stderr, "Error: failed to receive nl80211 response: %s\n",
                        nl_geterror(ret));
                goto cleanup;
            }
        }

        if (ctx.error) {
            fprintf(stderr, "Error: nl80211 returned error %d (%s)\n",
                    ctx.error, strerror(-ctx.error));
            ret = -1;
            goto cleanup;
        }
    }

    if (!ctx.got_wiphy) {
        fprintf(stderr, "Error: no wiphy info received\n");
        ret = -1;
        goto cleanup;
    }

    ret = 0;

cleanup:
    if (msg)
        nlmsg_free(msg);
    if (sock)
        nl_socket_free(sock);
    return ret;
}

/* Output capabilities as JSON */
static void print_caps_json(const struct wifi_caps *caps)
{
    int i;

    JSON_OBJ_START();
    JSON_STR("phy", caps->phy);
    if (caps->iface[0])
        JSON_STR("iface", caps->iface);
    JSON_BOOL("supports_ap", caps->supports_ap);
    JSON_BOOL("supports_ht", caps->supports_ht);
    JSON_BOOL("supports_vht", caps->supports_vht);
    JSON_BOOL("supports_short_gi_20", caps->supports_short_gi_20);
    JSON_BOOL("supports_short_gi_40", caps->supports_short_gi_40);

    /* 2.4 GHz channels */
    JSON_ARR_START("channels_2g");
    for (i = 0; i < caps->channel_2g_count; i++) {
        if (i > 0) fprintf(stdout, ",");
        fprintf(stdout, "%d", caps->channel_2g[i]);
    }

    fprintf(stdout, "  ],\n");

    /* 5 GHz channels (last field: no trailing comma before the closing brace) */
    fprintf(stdout, "  \"channels_5g\": [");
    for (i = 0; i < caps->channel_5g_count; i++) {
        if (i > 0) fprintf(stdout, ",");
        fprintf(stdout, "%d", caps->channel_5g[i]);
    }
    fprintf(stdout, "]\n");

    JSON_OBJ_END();
}

/* Print usage information */
static void usage(const char *prog)
{
    fprintf(stderr, "Usage: %s --phy=<phy> | --iface=<iface>\n", prog);
    fprintf(stderr, "\nScan WiFi adapter capabilities via nl80211.\n");
    fprintf(stderr, "\nOptions:\n");
    fprintf(stderr, "  --phy=<phy>     Physical device name (e.g., phy0)\n");
    fprintf(stderr, "  --iface=<iface> Interface name (e.g., wlp2s0)\n");
    fprintf(stderr, "  -h, --help      Show this help\n");
}

int main(int argc, char *argv[])
{
    struct wifi_caps caps;
    const char *target = NULL;
    int i;

    if (argc < 2) {
        usage(argv[0]);
        return 1;
    }

    /* Parse arguments */
    for (i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--phy=", 6) == 0) {
            target = argv[i] + 6;
        } else if (strncmp(argv[i], "--iface=", 8) == 0) {
            target = argv[i] + 8;
        } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "Error: unknown option '%s'\n", argv[i]);
            usage(argv[0]);
            return 1;
        }
    }

    if (!target) {
        fprintf(stderr, "Error: --phy or --iface required\n");
        usage(argv[0]);
        return 1;
    }

    /* Initialize caps */
    memset(&caps, 0, sizeof(caps));

    /* Scan */
    if (wifi_scan(target, &caps) < 0) {
        fprintf(stderr, "Error: failed to scan WiFi capabilities\n");
        return 1;
    }

    /* Output JSON */
    print_caps_json(&caps);

    return 0;
}
