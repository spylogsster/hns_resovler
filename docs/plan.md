# Plan: Switch check_hns from hsd (JS) to hnsd (C binary)

## Context

check_hns currently uses `hsd` (JavaScript SPV node) to resolve HNS domains from the blockchain. The JS `bns` recursive resolver cannot handle HNS-native nameservers (e.g. `a.namenode.`), requiring a complex ~170-line direct NS fallback workaround. Switching to `hnsd` (C binary with libunbound) provides proper recursive resolution natively and eliminates the JS dependency entirely.

## Architecture Change

**Before**: hsd SPVNode runs in-process (same Node.js event loop), uses `bns` for DNS wire protocol
**After**: hnsd runs as a child process, check_hns.js manages its lifecycle and queries its DNS resolver

## Build Toolchain

- Install MSYS2 packages: `mingw-w64-x86_64-toolchain`, `base-devel`, `mingw-w64-x86_64-unbound`
- Clone hnsd from https://github.com/handshake-org/hnsd
- Build: `./autogen.sh && ./configure && make`
- Output: `bin/hnsd.exe`

## Implementation Phases

### Phase 1: Build Infrastructure
- `build_hnsd.sh` — clones hnsd, installs deps, builds
- `build_hnsd.cmd` — Windows wrapper for MSYS2 shell
- Verify hnsd builds and runs

### Phase 2: DNS Wire Protocol
- `lib/dns_wire.js` — self-contained DNS query/response encoding (no npm deps)
- Unit tests in `test/test_dns_wire.js`

### Phase 3: hnsd Process Manager
- `lib/hnsd_manager.js` — spawn hnsd, detect sync via stderr parsing, PID file management
- Integration tests in `test/test_hnsd_spawn.js`

### Phase 4: Rewrite check_hns.js
- Replace hsd imports with hnsd_manager
- Replace bns queries with dns_wire
- Remove direct NS fallback (hnsd/libunbound handles it natively)
- Keep same CLI: sync/query/auto modes

### Phase 5: Verification
- E2E tests against known domains (nb, shakeshift, etc.)
- Update README and package.json
- Remove hsd dependency

## Ports

| Service              | Port  |
|----------------------|-------|
| Authoritative NS     | 15349 |
| Recursive Resolver   | 15350 |

## File Structure

```
check_hns/
  check_hns.js              # Main script (rewritten)
  lib/
    dns_wire.js              # DNS wire protocol (encode/decode)
    hnsd_manager.js          # hnsd process lifecycle
  build_hnsd.sh              # MSYS2 build script
  build_hnsd.cmd             # Windows wrapper
  bin/hnsd.exe               # Built binary (gitignored)
  vendor/hnsd/               # Cloned source (gitignored)
  test/
    test_dns_wire.js         # Unit tests
    test_hnsd_spawn.js       # Integration tests
    test_resolve.js          # E2E tests
  docs/plan.md               # This file
```

## Risks

1. **Windows sync issue (#128)**: hnsd doesn't respond to DNS during initial sync — must wait for full sync before querying
2. **HNS-native NS resolution**: If libunbound can't handle some edge cases, re-add simplified direct NS fallback
3. **Static vs dynamic linking**: May need to distribute libunbound DLLs alongside hnsd.exe
