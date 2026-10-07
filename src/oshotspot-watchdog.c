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
 *   oshotspot-watchdog monitor --interval=10 --project-dir=/usr/lib/oshotspot
 *
 * Monitors hostapd, dnsmasq and the Python event collector, restarts if crashed.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <time.h>

#include "oshotspot.h"

#define MAX_RESTARTS 3
#define RESTART_COOLDOWN 300  /* 5 minutes -- reset restart counter after this */
#define DNSMASQ_GRACE 15      /* seconds to skip dnsmasq check after startup/restart */
#define DEFAULT_INTERVAL 10
#define PID_DIR "/run"

static volatile sig_atomic_t running = 1;

/* PID file paths */
static const char *PID_HOSTAPD  = "/run/oshotspot-hostapd.pid";
static const char *PID_DNSMASQ  = "/run/oshotspot-dnsmasq.pid";
static const char *PID_TAILER   = "/run/oshotspot-tailer.pid";

/* Process names for identification */
static const char *NAME_HOSTAPD = "hostapd";
static const char *NAME_DNSMASQ = "dnsmasq";
static const char *NAME_TAILER  = "tailer";

/* Default project dir (overridable via --project-dir) */
static char project_dir[512] = "/usr/lib/oshotspot";

/* Track last restart time per process for cooldown-based counter reset */
static time_t last_restart_time[3] = {0, 0, 0};

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
                         int *restart_count, const char *restart_cmd,
                         int process_index)
{
    pid_t pid;

    pid = read_pid(pid_file);

    if (is_running(pid)) {
        /* Process is alive -- reset the restart counter after the
           cooldown period so transient failures don't permanently
           exhaust the restart budget. */
        if (*restart_count > 0 && last_restart_time[process_index] > 0) {
            if (time(NULL) - last_restart_time[process_index] >= RESTART_COOLDOWN) {
                fprintf(stderr, "[watchdog] %s stable for %ds, resetting restart counter\n",
                        name, RESTART_COOLDOWN);
                *restart_count = 0;
            }
        }
        return 0; /* OK */
    }

    /* Process is not running */
    fprintf(stderr, "[watchdog] %s is not running (PID %d, time=%ld)\n",
            name, pid, (long)time(NULL));

    if (*restart_count >= MAX_RESTARTS) {
        fprintf(stderr, "[watchdog] %s: restart limit reached (%d)\n",
                name, MAX_RESTARTS);
        return -1;
    }

    /* Try to restart */
    fprintf(stderr, "[watchdog] Restarting %s (attempt %d/%d)...\n",
            name, *restart_count + 1, MAX_RESTARTS);

    if (system(restart_cmd) != 0) {
        fprintf(stderr, "[watchdog] Failed to restart %s\n", name);
        (*restart_count)++;
        last_restart_time[process_index] = time(NULL);
        return -1;
    }

    (*restart_count)++;
    last_restart_time[process_index] = time(NULL);
    fprintf(stderr, "[watchdog] %s restarted successfully (time=%ld)\n",
            name, (long)time(NULL));

    /* Write grace period timestamp for dnsmasq so we don't
       immediately re-check it after just restarting it. */
    if (process_index == 1) { /* dnsmasq */
        FILE *gf = fopen("/run/oshotspot-dnsmasq-started", "w");
        if (gf) {
            fprintf(gf, "%ld\n", (long)time(NULL));
            fclose(gf);
        }
    }

    return 0;
}

/* Check if a process was recently started (grace period file).  Returns
   true if the timestamp file exists and is younger than DNSMASQ_GRACE
   seconds, meaning we should skip the check to avoid false-positive
   restarts during the startup window. */
static int in_grace_period(const char *timestamp_file)
{
    struct stat st;
    if (stat(timestamp_file, &st) != 0)
        return 0;
    return (time(NULL) - st.st_mtime) < DNSMASQ_GRACE;
}

/* Check all managed processes */
int watchdog_check(void)
{
    int restart_hostapd = 0;
    int restart_dnsmasq = 0;
    int restart_tailer = 0;
    int status = 0;

    char cmd_hostapd[512];
    char cmd_dnsmasq[512];
    char cmd_tailer[1024];

    snprintf(cmd_hostapd, sizeof(cmd_hostapd),
             "hostapd -B /etc/oshotspot/hostapd.conf "
             "-P /run/oshotspot-hostapd.pid "
             ">> /var/log/oshotspot/hostapd.log 2>&1");

    snprintf(cmd_dnsmasq, sizeof(cmd_dnsmasq),
             "dnsmasq "
             "--conf-file=/etc/oshotspot/dnsmasq.conf "
             "--pid-file=/run/oshotspot-dnsmasq.pid "
             "--log-facility=/var/log/oshotspot/dnsmasq.log");

    snprintf(cmd_tailer, sizeof(cmd_tailer),
             "nohup python3 %s/events/tailer.py --daemon "
             "--pid-file /run/oshotspot-tailer.pid "
             ">> /var/log/oshotspot/events.log 2>&1 &",
             project_dir);

    /* Check hostapd */
    fprintf(stderr, "[watchdog] check hostapd PID=%d time=%ld\n",
            read_pid(PID_HOSTAPD), (long)time(NULL));
    if (check_process(NAME_HOSTAPD, PID_HOSTAPD, &restart_hostapd, cmd_hostapd, 0) < 0)
        status = -1;

    /* Check dnsmasq -- skip if within the grace period after startup
       or restart.  The timestamp file /run/oshotspot-dnsmasq-started
       is written by start.sh after dnsmasq launches successfully, and
       by the watchdog after each successful restart.  This prevents
       false-positive restarts during the window when dnsmasq is still
       initializing or when it was just restarted by reload-dns-blocking
       (which now uses SIGHUP instead of a full kill+restart). */
    if (in_grace_period("/run/oshotspot-dnsmasq-started")) {
        fprintf(stderr, "[watchdog] dnsmasq in grace period, skipping check\n");
    } else {
        fprintf(stderr, "[watchdog] check dnsmasq PID=%d time=%ld\n",
                read_pid(PID_DNSMASQ), (long)time(NULL));
        if (check_process(NAME_DNSMASQ, PID_DNSMASQ, &restart_dnsmasq, cmd_dnsmasq, 1) < 0)
            status = -1;
    }

    /* Check event collector (tailer) */
    fprintf(stderr, "[watchdog] check tailer PID=%d time=%ld\n",
            read_pid(PID_TAILER), (long)time(NULL));
    if (check_process(NAME_TAILER, PID_TAILER, &restart_tailer, cmd_tailer, 2) < 0)
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
    fprintf(stderr, "  %s check [--project-dir=DIR]         One-shot check\n", prog);
    fprintf(stderr, "  %s monitor [--interval=N] [--project-dir=DIR]  Continuous monitoring\n", prog);
    fprintf(stderr, "  %s -h, --help                        Show this help\n", prog);
    fprintf(stderr, "\nMonitor hostapd, dnsmasq and the event collector, restart if crashed.\n");
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

    /* Parse --project-dir from any position in argv */
    for (i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--project-dir=", 14) == 0) {
            strncpy(project_dir, argv[i] + 14, sizeof(project_dir) - 1);
            project_dir[sizeof(project_dir) - 1] = '\0';
        }
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
