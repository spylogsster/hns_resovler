# check-hns

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

**2. Proxy mode** — start hnsd + local DNS proxy on port 53:

```bash
# Windows: run terminal as Administrator
# Mac/Linux: use sudo
node check_hns.js proxy
```

Starts hnsd, waits for sync, then runs a DNS proxy on port 53 that forwards all queries to hnsd. Configure your system DNS to `127.0.0.1` and browse HNS domains in any browser.

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

## DNS Proxy — browse HNS domains

The proxy mode lets you browse HNS websites in any browser:

```bash
# 1. Start the proxy (requires admin/root for port 53)
node check_hns.js proxy

# 2. Configure system DNS to 127.0.0.1
#    Windows (PowerShell as Admin):
#      netsh interface ip set dns "Wi-Fi" static 127.0.0.1
#    macOS:
#      sudo networksetup -setdnsservers Wi-Fi 127.0.0.1
#    Linux:
#      sudo resolvectl dns <interface> 127.0.0.1

# 3. Open any browser and navigate to http://nb/ or http://shakeshift/

# 4. When done, restore DNS:
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
  ├── lib/dns_proxy.js       Local DNS proxy (UDP forwarder port 53 → hnsd)
  └── bin/hnsd[.exe]         Built hnsd binary (gitignored)
```

See [docs/plan.md](docs/plan.md) for detailed architecture notes.

## Ports

| Port  | Service                     |
|-------|-----------------------------|
| 53    | DNS proxy (proxy mode only) |
| 15349 | Authoritative root server   |
| 15350 | Recursive resolver (query)  |

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
