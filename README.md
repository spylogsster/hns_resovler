# check-hns

Resolve Handshake (HNS) domains directly from the blockchain using an hsd SPV node.

Unlike DoH resolvers that delegate to external nameservers, this tool runs a lightweight SPV node that syncs Handshake blockchain headers and resolves names from on-chain data.

## Setup

```bash
npm install
```

Requires Node.js >= 18.

## Usage

### Three modes

**1. Sync mode** — start the SPV node and keep it running:

```bash
node check_hns.js sync
```

First run syncs the full blockchain (~30 min). Subsequent runs resume from cached state (~1 min).
Chain data is stored in `%TEMP%/hsd-spv-check/` (Windows) or `/tmp/hsd-spv-check/` (Linux/Mac).

**2. Query mode** — query a running SPV node:

```bash
node check_hns.js query nb
node check_hns.js query welcome.nb handshake.conference
```

Requires the SPV node to be running (started via `sync` mode in another terminal).

**3. Auto mode** — sync + query + stop (all-in-one):

```bash
node check_hns.js nb welcome.nb shakeshift
```

Waits for full sync, resolves all domains, then exits.

### npm scripts

```bash
npm start              # same as: node check_hns.js sync
npm run sync           # same as: node check_hns.js sync
npm run query -- nb    # same as: node check_hns.js query nb
```

## Recommended workflow

```bash
# Terminal 1: start SPV node (keep running)
node check_hns.js sync

# Terminal 2: query as needed
node check_hns.js query nb
node check_hns.js query welcome.nb
node check_hns.js query handshake.conference
```

## Example output

```
HNS Domain Resolver (querying SPV node at 127.0.0.1:15350)
Domains: nb, welcome.nb, handshake.conference

=======================================================
Domain: nb
=======================================================
  A      35.81.54.236  (TTL=86400)

=======================================================
Domain: welcome.nb
=======================================================
  RCODE: SERVFAIL
  No records found

=======================================================
Domain: handshake.conference
=======================================================
  RCODE: NXDOMAIN
  (authority) SOA    ns1.skyinclude. ops.domains.skyinclude.com. (serial=1)
  NXDOMAIN - domain not found

  Trying parent TLD: conference
  Parent TLD "conference" also not found
```

## How it works

1. The hsd SPV node connects to Handshake P2P peers and syncs block headers
2. When queried, it fetches name proofs from peers and resolves them against the blockchain state
3. An authoritative root server translates on-chain name data into DNS responses
4. A recursive resolver handles the full DNS resolution chain (following NS delegations, etc.)

The SPV node uses ~12 MB of memory with a full DNS cache and only downloads block headers (not full blocks), making it lightweight compared to a full HSD node.

## Ports

| Port  | Service                     |
|-------|-----------------------------|
| 15349 | Authoritative root server   |
| 15350 | Recursive resolver (query)  |
| 15351 | HTTP API                    |

All bound to `127.0.0.1` (localhost only).
