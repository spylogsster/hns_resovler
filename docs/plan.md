# check-hns v2: hnsd-based HNS domain resolution

## Context

check-hns resolves Handshake (HNS) domains directly from the blockchain. v1 used `hsd` (JavaScript SPV node with `bns` recursive resolver), which couldn't handle HNS-native nameservers (e.g. `a.namenode.`) and required a complex direct NS fallback. v2 switches to `hnsd` (C binary with libunbound), providing native recursive resolution and zero npm dependencies.

## Architecture

```
check_hns.js               CLI entry point (sync/query/auto modes)
  ├── lib/dns_wire.js       DNS wire protocol encoder/decoder (A, AAAA, NS, CNAME, TXT, SOA, MX, SRV, DS)
  ├── lib/hnsd_manager.js   hnsd process lifecycle (spawn, sync detection, readiness polling, PID file)
  └── bin/hnsd.exe          Built hnsd binary + DLLs (gitignored)

build_hnsd.sh               MSYS2/MINGW64 build script
build_hnsd.cmd              Windows wrapper

test/
  test_dns_wire.js          14 unit tests — wire format encoding/decoding
  test_hnsd_spawn.js        6 integration tests — binary discovery, PID file management
  test_resolve.js           6 E2E tests — domain resolution against running hnsd
```

## Build requirements (Windows)

MSYS2 MINGW64 with packages:
- `base-devel`, `mingw-w64-x86_64-toolchain` (gcc, make, autotools)
- `mingw-w64-x86_64-unbound` (libunbound for recursive DNS)
- `git`

Build: `./autogen.sh && ./configure && make` inside vendor/hnsd/

Runtime DLLs copied to bin/: `libunbound-8.dll`, `libcrypto-3-x64.dll`, `libssl-3-x64.dll`

## hnsd integration details

### Process management
- hnsd spawned as child process via `child_process.spawn()`
- Sync detected by parsing stderr for `"chain is fully synced"` message
- Height tracked via `"chain (N):"` and `"new height: N"` patterns
- Checkpoint flag (`-t`) enabled by default for faster initial sync (~136k block skip)
- Post-sync readiness polling (hnsd issue #128: Windows doesn't respond to DNS during sync)

### Ports
| Port  | Service               |
|-------|-----------------------|
| 15349 | Authoritative root NS |
| 15350 | Recursive resolver    |

### DNS resolution flow
1. Query hnsd recursive resolver (port 15350) for A, AAAA, NS, CNAME, TXT
2. If SERVFAIL/REFUSED → direct NS fallback:
   - Query authoritative root (port 15349) for TLD's NS + glue records
   - For HNS-native nameservers without glue, resolve NS TLD via root
   - Query external nameservers directly on port 53
3. If NXDOMAIN → try parent TLD to show delegation info

### Verified resolution results
| Domain           | Result                    | Method              |
|------------------|---------------------------|---------------------|
| nb               | A 35.81.54.236            | libunbound recursive |
| shakeshift       | A 23.88.55.248            | libunbound recursive (HNS-native NS: a.namenode.) |
| welcome.nb       | NXDOMAIN + parent fallback | libunbound recursive |
| nonexistent12345 | NXDOMAIN                  | libunbound recursive |

libunbound handles HNS-native nameserver delegations natively — the direct NS fallback is kept as a safety net but was not needed during testing.

## Key differences from v1

| Aspect              | v1 (hsd)                          | v2 (hnsd)                        |
|----------------------|-----------------------------------|----------------------------------|
| SPV node             | hsd JS (in-process)              | hnsd C binary (child process)    |
| Recursive resolver   | bns (JS)                         | libunbound (C)                   |
| HNS-native NS        | Fails → direct NS fallback      | Resolves natively                |
| npm dependencies     | hsd (heavy, pulls bns, bcrypto)  | None                             |
| DNS wire protocol    | bns library                      | lib/dns_wire.js (self-contained) |
| Memory usage         | ~12 MB (JS heap)                 | ~38 MB (native + libunbound)     |
| Build requirement    | npm install                      | MSYS2 + build from source        |
