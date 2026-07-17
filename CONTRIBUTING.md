# Contributing

Welcome! Contributions to OSHotspot are welcome and appreciated.

## Project Maintainer

**OLOJEDE Samuel** — [GitHub](https://github.com/King03-sam)

## How to Contribute

### Reporting Bugs

- Open a GitHub Issue with the "bug" label
- Include: OS, kernel version, `oshotspot doctor` output, relevant logs

### Suggesting Features

- Open a GitHub Issue with the "enhancement" label
- Describe the use case and expected behavior

### Submitting Code

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test on a real Linux system
5. Commit with a clear message
6. Open a Pull Request

## Development Setup

### Requirements

- Linux with WiFi adapter (AP mode supported)
- hostapd, dnsmasq, iw, iptables/nftables, iproute2
- Python 3 (for web dashboard)
- Root access (sudo)
- gcc + libnl-genl-3-dev (for C tools, optional)

### Local Development

```bash
git clone https://github.com/King03-sam/OSHotspot.git
cd OSHotspot
sudo ./install.sh
sudo oshotspot start
sudo oshotspot web
```

### Web Dashboard Development

The dashboard runs without any build step:

```bash
sudo python3 web/serve.py
```

Edit files in `web/static/` — changes are served directly.

## Code Style

### Bash

- Always use `set -euo pipefail`
- Source `utils.sh` for shared functions
- Use `require_root()` and `load_config()` at script entry
- Quote all variables: `"${var}"`

### C (optional tools)

- C99 standard (`-std=c99`)
- Use `oshotspot.h` for shared types
- JSON output via helper macros (no external JSON library)
- libnl for netlink communication (nl80211)
- All functions should handle errors gracefully
- Use `fprintf(stderr, ...)` for errors, `printf(...)` for output
- Compile with `-Wall -Wextra -O2`

### Python (web server)

- Stdlib only — no pip dependencies
- All API routes go through `handler.py`
- Parse shell script output via `parsers.py`

### JavaScript (dashboard)

- Vanilla JS — no frameworks or build tools
- All modules attach to `window.OS` namespace
- DOM helpers: `OS.$()`, `OS.esc()`, `OS.formatBytes()`
- API calls: use `OS.api.fetch()` (handles token injection + timeout)

## Pull Request Guidelines

- One fix or feature per PR
- Describe what changed and why
- Test on a real Linux system before submitting
- Keep PRs focused — avoid unrelated changes

## Project Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed system overview with diagrams.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
