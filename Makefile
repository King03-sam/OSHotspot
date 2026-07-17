# OSHotspot - C Tools Build System
# Copyright 2026 OLOJEDE Samuel
# Licensed under Apache License 2.0

CC = gcc
CFLAGS = -Wall -Wextra -O2 -Iinclude -std=gnu99
LDFLAGS_SCAN = -lnl-genl-3 -lnl-3

PREFIX ?= /usr/local
BINDIR = $(PREFIX)/bin

SRCS = src/oshotspot-scan.c src/oshotspot-gen.c src/oshotspot-watchdog.c
OBJS = $(SRCS:.c=.o)

.PHONY: all install clean

all: oshotspot-scan oshotspot-gen oshotspot-watchdog

# Build rules
src/oshotspot-scan.o: src/oshotspot-scan.c include/oshotspot.h
	$(CC) $(CFLAGS) -c $< -o $@

src/oshotspot-gen.o: src/oshotspot-gen.c include/oshotspot.h
	$(CC) $(CFLAGS) -c $< -o $@

src/oshotspot-watchdog.o: src/oshotspot-watchdog.c include/oshotspot.h
	$(CC) $(CFLAGS) -c $< -o $@

oshotspot-scan: src/oshotspot-scan.o
	$(CC) -o $@ $< $(LDFLAGS_SCAN)

oshotspot-gen: src/oshotspot-gen.o
	$(CC) -o $@ $<

oshotspot-watchdog: src/oshotspot-watchdog.o
	$(CC) -o $@ $<

install: all
	install -d $(DESTDIR)$(BINDIR)
	install -m 755 oshotspot-scan $(DESTDIR)$(BINDIR)/
	install -m 755 oshotspot-gen $(DESTDIR)$(BINDIR)/
	install -m 755 oshotspot-watchdog $(DESTDIR)$(BINDIR)/

clean:
	rm -f src/*.o oshotspot-scan oshotspot-gen oshotspot-watchdog
