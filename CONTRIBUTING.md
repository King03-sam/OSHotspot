# Contributing

Welcome! Contributions to **OSHotspot** are welcome and appreciated.

## Project Maintainer

**OLOJEDE Samuel**, [GitHub](https://github.com/King03-sam)

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

Edit files in `web/static/`, changes are served directly.

## Code Style

### Bash

- Always use `set -euo pipefail`
- Source `utils.sh` for shared functions
- Use `require_root()` and `load_config()` at script entry
- Quote all variables: `"${var}"`

### C (optional tools)

- C99 standard (`-std=gnu99`, includes GNU extensions)
- Use `oshotspot.h` for shared types
- JSON output via helper macros (no external JSON library)
- libnl for netlink communication (nl80211)
- All functions should handle errors gracefully
- Use `fprintf(stderr, ...)` for errors, `printf(...)` for output
- Compile with `-Wall -Wextra -O2`

### Python (web server)

- Web server itself is stdlib only; the event collector uses two pip deps, `pygtail` and `tenacity` (see `requirements.txt`)
- All API routes go through `handler.py`
- Parse shell script output via `parsers.py`

### JavaScript (dashboard)

- Vanilla JS, no frameworks or build tools
- All modules attach to `window.OS` namespace
- DOM helpers: `OS.$()`, `OS.esc()`, `OS.formatBytes()`
- API calls: use `OS.api()` (handles token injection + timeout + SSE)
- Modules: `core.js`, `api.js`, `app.js`, `nav.js`, `theme.js`, `toast.js`, `status.js`, `clients.js`, `actions.js`, `config.js`, `traffic.js`, `doctor.js`, `qr.js`, `logs.js`, `activity.js`, `policy.js`, `captive.js`, `span.js`, `events.js`, `login.js`, `live.js`, `mail.js`, `notifications.js`, `users.js`, `audit.js`, `vpn.js`, `about.js`
- Application category blocking (App Block) is implemented inside `policy.js`, its controls are embedded in the Domain Policy page, not a standalone module.

## Pull Request Guidelines

- One fix or feature per PR
- Describe what changed and why
- Test on a real Linux system before submitting
- Keep PRs focused, avoid unrelated changes

## Project Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed system overview with diagrams.

## Release Packaging

To create a new release:

1. Bump version in `ARCHITECTURE.md` header and `config.conf.example`
2. Commit and push, then tag:
   ```bash
   git tag -a v5.1 -m "Release v5.1"
   git push origin v5.1
   ```
3. Publish the release (needs a `GITHUB_TOKEN` with `repo` scope):
   ```bash
   export GITHUB_TOKEN="..."
   ./deploy.sh v5.1
   ```
   This builds the `.tar.gz` via `package.sh` and uploads it to GitHub Releases.

### Packaging Files
- `package.sh`, reads `debian/install` as the source of truth; builds the tarball
- `debian/install`, file list defining install paths
- `deploy.sh`, builds and publishes the GitHub release

### Testing the Package Locally
```bash
./package.sh v5.1
# Verify:
tar tzf dist/oshotspot-v5.1.tar.gz    # check contents
```

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
