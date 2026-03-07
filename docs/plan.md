# check-hns v2: hnsd-based HNS domain resolution

## Context

check-hns resolves Handshake (HNS) domains directly from the blockchain. v1 used `hsd` (JavaScript SPV node with `bns` recursive resolver), which couldn't handle HNS-native nameservers (e.g. `a.namenode.`) and required a complex direct NS fallback. v2 switches to `hnsd` (C binary with libunbound), providing native recursive resolution and zero npm dependencies.

## Architecture

```
check_hns.js               CLI entry point (sync/query/proxy/auto modes)
  ├── lib/dns_wire.js       DNS wire protocol encoder/decoder (A, AAAA, NS, CNAME, TXT, SOA, MX, SRV, DS)
  ├── lib/hnsd_manager.js   hnsd process lifecycle (spawn, sync detection, readiness polling, PID file)
  ├── lib/dns_proxy.js      HTTP proxy (port 8053) + DNS proxy (port 53) via hnsd
  └── bin/hnsd[.exe]        Built hnsd binary (gitignored)

build_hnsd.sh               Cross-platform build script (Windows/macOS/Linux)
build_hnsd.cmd              Windows wrapper (launches MSYS2 MINGW64 shell)

test/
  test_dns_wire.js          14 unit tests — wire format encoding/decoding
  test_hnsd_spawn.js        6 integration tests — binary discovery, PID file management
  test_resolve.js           6 E2E tests — domain resolution against running hnsd
```

## Build requirements

### Windows
MSYS2 MINGW64 with packages: `base-devel`, `mingw-w64-x86_64-toolchain`, `mingw-w64-x86_64-unbound`, `git`

Runtime DLLs copied to bin/: `libunbound-8.dll`, `libcrypto-3-x64.dll`, `libssl-3-x64.dll`

### macOS
Homebrew packages: `autoconf`, `automake`, `libtool`, `unbound`, `openssl`, `git`

### Linux
- Debian/Ubuntu: `build-essential`, `autoconf`, `automake`, `libtool`, `libunbound-dev`, `libssl-dev`, `git`
- Fedora/RHEL: `gcc`, `make`, `autoconf`, `automake`, `libtool`, `unbound-devel`, `openssl-devel`, `git`
- Arch: `base-devel`, `autoconf`, `automake`, `libtool`, `unbound`, `openssl`, `git`

Build: `./autogen.sh && ./configure && make` inside vendor/hnsd/

## hnsd integration details

### Process management
- hnsd spawned as child process via `child_process.spawn()`
- Sync detected by parsing stdout for `"chain is fully synced"` message
- Height tracked via `"chain (N):"` and `"new height: N"` patterns on stdout
- Progress printed every 10 seconds (height, target %, elapsed time)
- Checkpoint flag (`-t`) enabled by default for faster initial sync (~136k block skip)
- Post-sync readiness polling (hnsd issue #128: Windows doesn't respond to DNS during sync)

### Ports
| Port  | Service                          |
|-------|----------------------------------|
| 8053  | HTTP proxy (proxy mode, default) |
| 53    | DNS proxy (proxy --dns mode)     |
| 15349 | Authoritative root NS            |
| 15350 | Recursive resolver               |

### DNS resolution flow
1. Query hnsd recursive resolver (port 15350) for A, AAAA, NS, CNAME, TXT
2. If SERVFAIL/REFUSED → direct NS fallback:
   - Query authoritative root (port 15349) for TLD's NS + glue records
   - For HNS-native nameservers without glue, resolve NS TLD via root
   - Query external nameservers directly on port 53
3. If NXDOMAIN → try parent TLD to show delegation info

### ICANN domain resolution
hnsd's authoritative root server includes a hardcoded fallback for ICANN's root zone (`src/tld.h` — 1,481 TLDs). When a query is for an ICANN TLD (.com, .org, .net, etc.), hnsd returns embedded NS records pointing to real ICANN root servers. libunbound then follows these delegations to resolve regular domains like google.com.

This means hnsd is a **full recursive resolver** for both HNS and ICANN domains, making the DNS proxy a simple UDP forwarder.

### Proxy architecture
```
Chrome (--proxy-server=http://127.0.0.1:8053)
  ↓ HTTP/CONNECT (port 8053)
HTTP proxy (lib/dns_proxy.js)
  ↓ DNS resolve via UDP (port 15350)
hnsd recursive resolver (libunbound)
  ↓ query (port 15349)
hnsd authoritative root
  ├─ HNS domain → SPV blockchain lookup → NS delegation → recursive resolve
  ├─ ICANN domain → embedded root zone → NS delegation → recursive resolve
  └─ Blocked TLD (.onion, .eth, etc.) → NXDOMAIN
```

Alternative: DNS proxy mode (`--dns`) forwards UDP queries from port 53 → hnsd port 15350.
If hnsd doesn't respond within 5 seconds, the DNS proxy falls back to upstream DNS (8.8.8.8).

### Verified resolution results
| Domain           | Result                    | Method              |
|------------------|---------------------------|---------------------|
| nb               | A 35.81.54.236            | libunbound recursive |
| shakeshift       | A 23.88.55.248            | libunbound recursive (HNS-native NS: a.namenode.) |
| google.com       | A (varies)                | libunbound via ICANN fallback |
| welcome.nb       | NXDOMAIN + parent fallback | libunbound recursive |
| nonexistent12345 | NXDOMAIN                  | libunbound recursive |

libunbound handles HNS-native nameserver delegations natively — the direct NS fallback is kept as a safety net but was not needed during testing.

## Key differences from v1

| Aspect              | v1 (hsd)                          | v2 (hnsd)                        |
|----------------------|-----------------------------------|----------------------------------|
| SPV node             | hsd JS (in-process)              | hnsd C binary (child process)    |
| Recursive resolver   | bns (JS)                         | libunbound (C)                   |
| HNS-native NS        | Fails → direct NS fallback      | Resolves natively                |
| ICANN domains        | Not supported                    | Embedded root zone fallback      |
| npm dependencies     | hsd (heavy, pulls bns, bcrypto)  | None                             |
| DNS wire protocol    | bns library                      | lib/dns_wire.js (self-contained) |
| Browser integration  | None                             | HTTP proxy (8053) / DNS proxy (53) |
| Build requirement    | npm install                      | autotools + build from source    |
| Platforms            | Windows only                     | Windows, macOS, Linux            |
