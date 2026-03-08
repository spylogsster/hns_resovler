# check-hns

## Quick Start

```bash
node check_hns.js proxy
# Wait for sync, then launch Chrome with the proxy:
#   Windows: chrome.exe --proxy-server="http://127.0.0.1:8053"
#   macOS:   open -a "Google Chrome" --args --proxy-server="http://127.0.0.1:8053"
#   Linux:   google-chrome --proxy-server="http://127.0.0.1:8053"
# Navigate to http://nb/ or http://shakeshift/
```

---

Resolve Handshake (HNS) domains directly from the blockchain using the [hnsd](https://github.com/handshake-org/hnsd) SPV resolver.

Unlike DoH resolvers that delegate to external services, this tool runs a lightweight SPV node that syncs Handshake blockchain headers and resolves names from on-chain data. Uses libunbound for recursive DNS resolution, which natively handles HNS-native nameserver delegations (e.g. domains pointing to `a.namenode.`).

Also resolves regular ICANN domains (google.com, etc.) via hnsd's embedded root zone fallback.

No npm dependencies — only Node.js and the hnsd binary are required.

## Prerequisites

- Node.js >= 18
- hnsd binary (built from source, see below)

## Building hnsd

hnsd is a C binary built from source. The build script auto-detects your platform and installs dependencies.

### Windows

Requires [MSYS2](https://www.msys2.org) with the MINGW64 toolchain.

```
choco install msys2 -y
build_hnsd.cmd
```

### macOS

Requires [Homebrew](https://brew.sh).

```bash
./build_hnsd.sh
```

### Linux

Supports apt (Debian/Ubuntu), dnf (Fedora/RHEL), and pacman (Arch).

```bash
./build_hnsd.sh
```

The build script installs required packages (gcc, make, autotools, libunbound, git), clones the [hnsd repository](https://github.com/handshake-org/hnsd), builds it, and copies the binary to `./bin/`.

## Usage

### Four modes

**1. Sync mode** — start hnsd and keep it running:

```bash
node check_hns.js sync
```

First run syncs the blockchain from checkpoint (~5 min). Subsequent runs resume from cached state (~1 min).
Chain data is stored in `%TEMP%/hnsd-spv-check/` (Windows) or `/tmp/hnsd-spv-check/` (Linux/Mac).

**2. Proxy mode** — start hnsd + local proxy for browsing HNS domains:

```bash
node check_hns.js proxy                 # HTTP proxy on port 8053 (no root)
node check_hns.js proxy --port 9090     # HTTP proxy on custom port
node check_hns.js proxy --dns           # DNS proxy on port 53 (requires root)
```

**3. Query mode** — query a running hnsd instance:

```bash
node check_hns.js query nb
node check_hns.js query welcome.nb shakeshift
```

Requires hnsd to be running (started via `sync` mode in another terminal).

**4. Auto mode** — sync + query + stop (all-in-one):

```bash
node check_hns.js nb welcome.nb shakeshift
```

Waits for full sync, resolves all domains, then exits.

### Options

```
--hnsd-path <path>   Path to hnsd binary (default: auto-detect from ./bin/)
--port <port>        Proxy listen port (default: 8053 for HTTP, 53 for DNS)
--dns                Use DNS proxy instead of HTTP proxy (requires root/admin)
```

### npm scripts

```bash
npm start              # same as: node check_hns.js sync
npm run sync           # same as: node check_hns.js sync
npm run query -- nb    # same as: node check_hns.js query nb
npm test               # run unit tests
npm run test:e2e       # run E2E tests (requires running hnsd)
npm run test:all       # run all tests
```

## Browse HNS domains

### HTTP proxy (recommended, no root required)

```bash
# 1. Start the proxy (syncs blockchain, then starts HTTP proxy)
node check_hns.js proxy

# 2. Launch Chrome with the proxy
#    Windows:
chrome.exe --proxy-server="http://127.0.0.1:8053"
#    macOS:
open -a "Google Chrome" --args --proxy-server="http://127.0.0.1:8053"
#    Linux:
google-chrome --proxy-server="http://127.0.0.1:8053"

# 3. Navigate to http://nb/ or http://shakeshift/
```

The proxy prints the platform-specific Chrome launch command when ready.

### DNS proxy (requires root/admin)

```bash
# 1. Start the DNS proxy
#    Windows: run terminal as Administrator
#    Mac/Linux: use sudo
node check_hns.js proxy --dns

# 2. Set system DNS to 127.0.0.1
#    Windows: netsh interface ip set dns "Wi-Fi" static 127.0.0.1
#    macOS:   sudo networksetup -setdnsservers Wi-Fi 127.0.0.1
#    Linux:   sudo resolvectl dns <interface> 127.0.0.1

# 3. Navigate to http://nb/ in any browser

# 4. Restore DNS when done:
#    Windows: netsh interface ip set dns "Wi-Fi" dhcp
#    macOS:   sudo networksetup -setdnsservers Wi-Fi Empty
#    Linux:   sudo systemctl restart systemd-resolved
```

## Recommended workflow

```bash
# Terminal 1: start hnsd (keep running)
node check_hns.js sync

# Terminal 2: query as needed
node check_hns.js query nb
node check_hns.js query shakeshift
node check_hns.js query welcome.nb
```

## Example output

```
HNS Domain Resolver (querying hnsd at 127.0.0.1:15350)
Domains: nb, shakeshift, welcome.nb, nonexistent12345


=======================================================
Domain: nb
=======================================================
  A      35.81.54.236  (TTL=86393)
  NS     ns1.hns.id.  (TTL=86400)
  NS     ns2.hns.id.  (TTL=86400)

=======================================================
Domain: shakeshift
=======================================================
  A      23.88.55.248  (TTL=43175)

=======================================================
Domain: welcome.nb
=======================================================
  RCODE: NXDOMAIN (recursive resolver)
  (authority) SOA    ns1.hns.id. support.hns.id. (serial=2024032114)
  NXDOMAIN - domain not found

  Trying parent TLD: nb
  nb -> A 35.81.54.236
  (subdomain "welcome.nb" not found, but parent TLD resolves)

=======================================================
Domain: nonexistent12345
=======================================================
  RCODE: NXDOMAIN (recursive resolver)
  (authority) SOA    . . (serial=2026030708)
  NXDOMAIN - domain not found

Done.
```

## How it works

1. hnsd connects to Handshake P2P peers and syncs block headers (SPV mode)
2. An authoritative root server translates on-chain name data into DNS responses
3. libunbound handles recursive DNS resolution, following NS delegations including HNS-native nameservers
4. For regular ICANN domains, hnsd falls back to embedded root zone data (1,481 TLDs) which delegates to real ICANN root servers
5. If the recursive resolver returns SERVFAIL/REFUSED, a direct NS fallback queries the authoritative root for NS+glue and queries nameservers directly on port 53

## Architecture

```
check_hns.js                 CLI entry point (sync/query/proxy/auto modes)
  ├── lib/dns_wire.js        DNS wire protocol encoder/decoder (no npm deps)
  ├── lib/hnsd_manager.js    hnsd process lifecycle management
  ├── lib/dns_proxy.js       HTTP proxy + DNS proxy (resolves via hnsd)
  └── bin/hnsd[.exe]         Built hnsd binary (gitignored)
```

See [docs/plan.md](docs/plan.md) for detailed architecture notes.

## Ports

| Port  | Service                          |
|-------|----------------------------------|
| 8053  | HTTP proxy (proxy mode, default) |
| 53    | DNS proxy (proxy --dns mode)     |
| 15349 | Authoritative root server        |
| 15350 | Recursive resolver (query)       |

All bound to `127.0.0.1` (localhost only).

## Testing

```bash
# Unit tests (no hnsd required) — 20 tests
npm test

# E2E tests (requires running synced hnsd) — 6 tests
node check_hns.js sync    # start hnsd in another terminal
npm run test:e2e

# All tests — 26 tests
npm run test:all
```

## License

[MPL-2.0](LICENSE)
