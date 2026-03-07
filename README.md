# check-hns

Resolve Handshake (HNS) domains directly from the blockchain using the hnsd SPV resolver.

Unlike DoH resolvers that delegate to external nameservers, this tool runs a lightweight SPV node (hnsd) that syncs Handshake blockchain headers and resolves names from on-chain data using libunbound for recursive DNS resolution.

## Prerequisites

- Node.js >= 18
- hnsd binary (built from source, see below)

## Building hnsd

hnsd is a C binary that must be built from source. On Windows, this requires MSYS2 with the MINGW64 toolchain.

### Install MSYS2

```bash
choco install msys2 -y
```

Or download from https://www.msys2.org

### Build

**Windows (from cmd/PowerShell):**
```
build_hnsd.cmd
```

**MSYS2 MINGW64 shell:**
```bash
./build_hnsd.sh
```

The build script:
1. Installs required packages (gcc, make, autotools, libunbound)
2. Clones the hnsd repository
3. Builds hnsd.exe
4. Copies the binary to `./bin/`

## Usage

### Three modes

**1. Sync mode** — start hnsd and keep it running:

```bash
node check_hns.js sync
```

First run syncs the full blockchain (~30 min). Subsequent runs resume from cached state (~1 min).
Chain data is stored in `%TEMP%/hnsd-spv-check/` (Windows) or `/tmp/hnsd-spv-check/` (Linux/Mac).

**2. Query mode** — query a running hnsd instance:

```bash
node check_hns.js query nb
node check_hns.js query welcome.nb shakeshift
```

Requires hnsd to be running (started via `sync` mode in another terminal).

**3. Auto mode** — sync + query + stop (all-in-one):

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

## Recommended workflow

```bash
# Terminal 1: start hnsd (keep running)
node check_hns.js sync

# Terminal 2: query as needed
node check_hns.js query nb
node check_hns.js query welcome.nb
node check_hns.js query shakeshift
```

## Example output

```
HNS Domain Resolver (querying hnsd at 127.0.0.1:15350)
Domains: nb, shakeshift

=======================================================
Domain: nb
=======================================================
  A      35.81.54.236  (TTL=86400)

=======================================================
Domain: shakeshift
=======================================================
  A      23.88.55.248  (TTL=300)
```

## How it works

1. The hnsd SPV node connects to Handshake P2P peers and syncs block headers
2. When queried, it fetches name proofs from peers and resolves them against the blockchain state
3. An authoritative root server translates on-chain name data into DNS responses
4. libunbound handles recursive DNS resolution (following NS delegations, including HNS-native nameservers)
5. If the recursive resolver fails for domains with HNS-native nameservers, a direct NS fallback queries the authoritative root for NS+glue and queries nameservers directly

## Architecture

```
check_hns.js
  ├── lib/dns_wire.js        # DNS wire protocol (encode/decode, no npm deps)
  ├── lib/hnsd_manager.js    # hnsd process lifecycle management
  └── bin/hnsd.exe           # Built hnsd binary (gitignored)
```

v2 uses hnsd (C binary with libunbound) instead of hsd (JavaScript SPV node with bns).
This provides better recursive resolution and eliminates npm dependencies.

## Ports

| Port  | Service                     |
|-------|-----------------------------|
| 15349 | Authoritative root server   |
| 15350 | Recursive resolver (query)  |

All bound to `127.0.0.1` (localhost only).

## Testing

```bash
# Unit tests (no hnsd required)
npm test

# E2E tests (requires running synced hnsd)
node check_hns.js sync &   # start hnsd in background
npm run test:e2e            # run E2E tests
```

## License

MPL-2.0
