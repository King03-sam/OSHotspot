/*
 * OSHotspot
 * Copyright 2026 OLOJEDE Samuel
 *
 * Licensed under the Apache License, Version 2.0
 *
 * oshotspot-watchdog - Process monitor with auto-restart
 *
 * Usage:
 *   oshotspot-watchdog check
 *   oshotspot-watchdog monitor --interval=10
 *
 * Monitors hostapd and dnsmasq, restarts if crashed.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <sys/types.h>
#include <time.h>

#include "oshotspot.h"

#define MAX_RESTARTS 3
#define DEFAULT_INTERVAL 10
#define PID_DIR "/run"

static volatile sig_atomic_t running = 1;

/* PID file paths */
static const char *PID_HOSTAPD  = "/run/oshotspot-hostapd.pid";
static const char *PID_DNSMASQ  = "/run/oshotspot-dnsmasq.pid";

/* Process names for pkill */
static const char *NAME_HOSTAPD = "hostapd";
static const char *NAME_DNSMASQ = "dnsmasq";

/* Signal handler for graceful shutdown */
static void signal_handler(int sig)
{
    (void)sig;
    running = 0;
}

/* Read PID from file */
static pid_t read_pid(const char *pid_file)
{
    FILE *f;
    pid_t pid;

    f = fopen(pid_file, "r");
    if (!f)
        return 0;

    if (fscanf(f, "%d", &pid) != 1) {
        fclose(f);
        return 0;
    }

    fclose(f);
    return pid;
}

/* Check if process is running */
static bool is_running(pid_t pid)
{
    if (pid <= 0)
        return false;
    return kill(pid, 0) == 0;
}

/* Check a single process */
static int check_process(const char *name, const char *pid_file,
                         int *restart_count)
{
    pid_t pid;

    pid = read_pid(pid_file);

    if (is_running(pid)) {
        return 0; /* OK */
    }

    /* Process is not running */
    fprintf(stderr, "[watchdog] %s is not running (PID %d)\n", name, pid);

    if (*restart_count >= MAX_RESTARTS) {
        fprintf(stderr, "[watchdog] %s: restart limit reached (%d)\n",
                name, MAX_RESTARTS);
        return -1;
    }

    /* Try to restart */
    fprintf(stderr, "[watchdog] Restarting %s (attempt %d/%d)...\n",
            name, *restart_count + 1, MAX_RESTARTS);

    if (strcmp(name, NAME_HOSTAPD) == 0) {
        /* Restart hostapd */
        if (system("hostapd -B /etc/oshotspot/hostapd.conf "
                    "-P /run/oshotspot-hostapd.pid "
                    ">> /var/log/oshotspot/hostapd.log 2>&1") != 0) {
            fprintf(stderr, "[watchdog] Failed to restart %s\n", name);
            (*restart_count)++;
            return -1;
        }
    } else if (strcmp(name, NAME_DNSMASQ) == 0) {
        /* Restart dnsmasq */
        if (system("dnsmasq "
                    "--conf-file=/etc/oshotspot/dnsmasq.conf "
                    "--pid-file=/run/oshotspot-dnsmasq.pid "
                    "--log-facility=/var/log/oshotspot/dnsmasq.log") != 0) {
            fprintf(stderr, "[watchdog] Failed to restart %s\n", name);
            (*restart_count)++;
            return -1;
        }
    }

    (*restart_count)++;
    fprintf(stderr, "[watchdog] %s restarted successfully\n", name);
    return 0;
}

/* Check all managed processes */
int watchdog_check(void)
{
    int restart_hostapd = 0;
    int restart_dnsmasq = 0;
    int status = 0;

    /* Check hostapd */
    if (check_process(NAME_HOSTAPD, PID_HOSTAPD, &restart_hostapd) < 0)
        status = -1;

    /* Check dnsmasq */
    if (check_process(NAME_DNSMASQ, PID_DNSMASQ, &restart_dnsmasq) < 0)
        status = -1;

    return status;
}

/* Monitor loop */
int watchdog_monitor(int interval_sec)
{
    struct sigaction sa;
    time_t last_check;

    /* Set up signal handlers */
    sa.sa_handler = signal_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);

    fprintf(stderr, "[watchdog] Starting monitor (interval: %ds)\n", interval_sec);

    last_check = time(NULL);

    while (running) {
        sleep(1);

        /* Check if it's time for a check */
        if (time(NULL) - last_check >= interval_sec) {
            watchdog_check();
            last_check = time(NULL);
        }
    }

    fprintf(stderr, "[watchdog] Monitor stopped\n");
    return 0;
}

/* Print usage information */
static void usage(const char *prog)
{
    fprintf(stderr, "Usage:\n");
    fprintf(stderr, "  %s check                    One-shot check\n", prog);
    fprintf(stderr, "  %s monitor [--interval=N]   Continuous monitoring\n", prog);
    fprintf(stderr, "  %s -h, --help               Show this help\n", prog);
    fprintf(stderr, "\nMonitor hostapd and dnsmasq, restart if crashed.\n");
}

int main(int argc, char *argv[])
{
    int interval = DEFAULT_INTERVAL;
    int i;

    if (argc < 2) {
        usage(argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0) {
        usage(argv[0]);
        return 0;
    }

    if (strcmp(argv[1], "check") == 0) {
        return watchdog_check();
    }

    if (strcmp(argv[1], "monitor") == 0) {
        for (i = 2; i < argc; i++) {
            if (strncmp(argv[i], "--interval=", 11) == 0) {
                interval = atoi(argv[i] + 11);
                if (interval < 1) interval = 1;
            }
        }
        return watchdog_monitor(interval);
    }

    fprintf(stderr, "Error: unknown command '%s'\n", argv[1]);
    usage(argv[0]);
    return 1;
}
