#!/usr/bin/env node
/**
 * Resolve Handshake (HNS) domains via hnsd SPV resolver (direct blockchain resolution).
 *
 * Uses the hnsd C binary (built from source) as a lightweight SPV node with
 * libunbound-based recursive DNS resolution. No npm dependencies required.
 *
 * Three modes:
 *   sync   - Start hnsd and keep it running (background daemon)
 *   query  - Query a running hnsd instance
 *   auto   - Start hnsd, sync, query, stop (all-in-one)
 *
 * Usage:
 *   node check_hns.js sync                         Start hnsd, wait for sync
 *   node check_hns.js query welcome.nb nb           Query running hnsd
 *   node check_hns.js nb shakeshift                 Auto mode
 *
 * Build hnsd first:
 *   build_hnsd.cmd   (Windows)
 *   ./build_hnsd.sh  (MSYS2 MINGW64 shell)
 */

'use strict';

const dgram = require('dgram');
const { types, buildQuery, parseResponse, rcodeName, typeName, recordToString } = require('./lib/dns_wire');
const hnsd = require('./lib/hnsd_manager');

const QUERY_TYPES = [types.A, types.AAAA, types.NS, types.CNAME, types.TXT];

// Codes that trigger direct NS fallback
const FALLBACK_CODES = new Set([2 /* SERVFAIL */, 5 /* REFUSED */]);

/**
 * Send a DNS query via UDP and return parsed response.
 */
function queryDNS(host, port, domain, qtype, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const buf = buildQuery(domain, qtype);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('TIMEOUT')); }, timeout);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      try { resolve(parseResponse(data)); } catch (e) { reject(e); }
    });
    sock.on('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
    sock.send(buf, 0, buf.length, port, host);
  });
}

/**
 * Extract the TLD from a domain.
 */
function getTLD(domain) {
  const dot = domain.lastIndexOf('.');
  return dot === -1 ? domain : domain.substring(dot + 1);
}

/**
 * Query the authoritative root server for NS referral for a TLD,
 * then resolve each nameserver's IP (also via root + direct query).
 * Returns array of {ns, ip}.
 */
async function getRootReferral(rsHost, nsPort, tld) {
  try {
    const res = await queryDNS(rsHost, nsPort, tld, types.NS, 5000);
    if (res.code !== 0) return [];

    // Collect glue A records from additional section
    const glue = {};
    for (const rr of res.additional) {
      if (rr.type === types.A)
        glue[rr.name.toLowerCase()] = rr.data.address;
    }

    // Collect NS names
    const nsNames = [];
    for (const rr of [...res.authority, ...res.answer]) {
      if (rr.type === types.NS) nsNames.push(rr.data.ns.toLowerCase());
    }

    const result = [];
    for (const ns of nsNames) {
      if (glue[ns]) { result.push({ ns, ip: glue[ns] }); continue; }

      // No glue — NS is likely an HNS name itself (e.g. a.namenode.).
      // Resolve its TLD via root to get glue IPs, then query for A record.
      const nsTLD = getTLD(ns.replace(/\.$/, ''));
      try {
        const tldRes = await queryDNS(rsHost, nsPort, nsTLD, types.A, 5000);
        for (const rr of tldRes.additional) {
          if (rr.type === types.A && rr.name.toLowerCase() === ns)
            glue[ns] = rr.data.address;
        }
        if (glue[ns]) { result.push({ ns, ip: glue[ns] }); continue; }

        // Follow NS TLD's nameservers to resolve the NS hostname
        const nsGlue = {};
        for (const rr of tldRes.additional) {
          if (rr.type === types.A) nsGlue[rr.name.toLowerCase()] = rr.data.address;
        }
        const nsTLDNSNames = [];
        for (const rr of [...tldRes.authority, ...tldRes.answer]) {
          if (rr.type === types.NS) nsTLDNSNames.push(rr.data.ns.toLowerCase());
        }
        for (const nsTLDNS of nsTLDNSNames) {
          const ip = nsGlue[nsTLDNS];
          if (!ip) continue;
          try {
            const aRes = await queryDNS(ip, 53, ns.replace(/\.$/, ''), types.A, 5000);
            if (aRes.code === 0) {
              for (const rr of aRes.answer) {
                if (rr.type === types.A) {
                  result.push({ ns, ip: rr.data.address });
                  break;
                }
              }
            }
            if (result.find(r => r.ns === ns)) break;
          } catch { /* try next */ }
        }
      } catch { /* skip this NS */ }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Directly query external nameservers for a domain.
 */
async function queryNameserversDirect(nameservers, domain, qtype) {
  for (const {ns, ip} of nameservers) {
    try {
      return await queryDNS(ip, 53, domain, qtype, 8000);
    } catch {
      // Try next NS
    }
  }
  return null;
}

async function resolveDomain(rsHost, rsPort, domain) {
  console.log(`\n${'='.repeat(55)}`);
  console.log(`Domain: ${domain}`);
  console.log('='.repeat(55));

  let anyRecords = false;
  let nxdomain = false;
  let needFallback = false;

  for (const qtype of QUERY_TYPES) {
    const tn = typeName(qtype);
    try {
      const res = await queryDNS(rsHost, rsPort, domain, qtype);
      if (res.code !== 0) {
        if (qtype === QUERY_TYPES[0]) {
          console.log(`  RCODE: ${rcodeName(res.code)} (recursive resolver)`);
          if (FALLBACK_CODES.has(res.code)) { needFallback = true; break; }
          for (const rr of res.authority) {
            const r = recordToString(rr);
            console.log(`  (authority) ${r.typeName.padEnd(6)} ${r.data}`);
          }
          if (res.code === 3) { nxdomain = true; break; }
        }
        continue;
      }
      for (const rr of res.answer) {
        const r = recordToString(rr);
        anyRecords = true;
        console.log(`  ${r.typeName.padEnd(6)} ${r.data}  (TTL=${r.ttl})`);
      }
    } catch (e) {
      if (qtype === QUERY_TYPES[0]) {
        console.log(`  ${tn.padEnd(6)} ERROR: ${e.message}`);
        if (e.message === 'TIMEOUT') break;
      }
    }
  }

  // Direct NS fallback: when the recursive resolver can't follow
  // HNS-native nameservers, get NS+glue from the authoritative root
  // and query the nameservers directly.
  if (needFallback) {
    const tld = getTLD(domain);
    console.log(`  Falling back to direct NS query for TLD "${tld}"...`);

    const nameservers = await getRootReferral(rsHost, hnsd.NS_PORT, tld);
    if (nameservers.length === 0) {
      console.log('  No nameservers with glue records found on-chain');
    } else {
      console.log(`  Nameservers: ${nameservers.map(n => `${n.ns} (${n.ip})`).join(', ')}`);

      for (const qtype of QUERY_TYPES) {
        const res = await queryNameserversDirect(nameservers, domain, qtype);
        if (!res) { if (qtype === QUERY_TYPES[0]) console.log('  All nameservers unreachable'); break; }

        if (res.code !== 0) {
          if (qtype === QUERY_TYPES[0]) {
            console.log(`  RCODE: ${rcodeName(res.code)} (direct NS)`);
            for (const rr of res.authority) {
              const r = recordToString(rr);
              console.log(`  (authority) ${r.typeName.padEnd(6)} ${r.data}`);
            }
            if (res.code === 3) { nxdomain = true; break; }
          }
          continue;
        }
        for (const rr of res.answer) {
          const r = recordToString(rr);
          anyRecords = true;
          console.log(`  ${r.typeName.padEnd(6)} ${r.data}  (TTL=${r.ttl})`);
        }
      }
    }
  }

  if (nxdomain) {
    console.log('  NXDOMAIN - domain not found');
    const dot = domain.indexOf('.');
    if (dot !== -1 && dot + 1 < domain.length) {
      const parent = domain.substring(dot + 1);
      console.log(`\n  Trying parent TLD: ${parent}`);
      try {
        const res = await queryDNS(rsHost, rsPort, parent, types.A);
        if (res.code === 0 && res.answer.length > 0) {
          for (const rr of res.answer) {
            const r = recordToString(rr);
            console.log(`  ${parent} -> ${r.typeName} ${r.data}`);
          }
          console.log(`  (subdomain "${domain}" not found, but parent TLD resolves)`);
        } else {
          console.log(`  Parent TLD "${parent}" also not found`);
        }
      } catch (e) {
        console.log(`  Parent TLD "${parent}" error: ${e.message}`);
      }
    }
  } else if (!anyRecords) {
    console.log('  No records found');
  }
}

// --- Modes ---

async function startSyncMode(opts) {
  console.log('HNS Domain Resolver — Sync Mode (hnsd)');
  console.log(`Data dir: ${hnsd.DATA_DIR}`);
  console.log(`Recursive resolver will be at 127.0.0.1:${hnsd.RS_PORT}`);
  console.log();

  const { child } = hnsd.start({ hnsdPath: opts.hnsdPath });

  // Forward hnsd stderr to console (for debugging)
  child.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) process.stderr.write(`  [hnsd] ${line}\n`);
    }
  });

  const cleanup = () => {
    console.log('\nShutting down...');
    hnsd.stop(child);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  hnsd.writePidFile(child.pid, hnsd.RS_PORT);

  console.log('Waiting for blockchain sync...');
  const height = await hnsd.waitForSync(child);

  console.log('Checking resolver readiness...');
  await hnsd.waitForReady(hnsd.RS_PORT);

  console.log(`\nhnsd fully synced at height ${height}`);
  console.log(`Recursive resolver ready at 127.0.0.1:${hnsd.RS_PORT}`);
  console.log('Press Ctrl+C to stop.\n');
  console.log('In another terminal, run:');
  console.log('  node check_hns.js query welcome.nb shakeshift');

  // Keep alive
  await new Promise(() => {});
}

async function queryMode(domains, opts) {
  let port = hnsd.RS_PORT;
  const info = hnsd.readPidFile();
  if (info) port = info.port;

  // Connectivity check
  try {
    await queryDNS('127.0.0.1', port, '.', types.NS, 3000);
  } catch {
    console.error(`Cannot reach hnsd at 127.0.0.1:${port}`);
    console.error('Start it first with: node check_hns.js sync');
    process.exit(1);
  }

  console.log(`HNS Domain Resolver (querying hnsd at 127.0.0.1:${port})`);
  console.log(`Domains: ${domains.join(', ')}\n`);

  for (const domain of domains) {
    await resolveDomain('127.0.0.1', port, domain);
  }
  console.log('\nDone.');
}

async function autoMode(domains, opts) {
  console.log('HNS Domain Resolver (hnsd — direct blockchain resolution)');
  console.log(`Domains: ${domains.join(', ')}`);
  console.log(`Data dir: ${hnsd.DATA_DIR}\n`);

  const { child } = hnsd.start({ hnsdPath: opts.hnsdPath, quiet: true });

  const cleanup = () => {
    console.log('\nShutting down...');
    hnsd.stop(child);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  console.log('Waiting for blockchain sync (first run takes ~30 min)...');
  console.log('Tip: use "node check_hns.js sync" in background for faster workflow.\n');

  const height = await hnsd.waitForSync(child);
  console.log('Checking resolver readiness...');
  await hnsd.waitForReady(hnsd.RS_PORT);
  console.log(`Chain synced (height ${height}), resolving...\n`);

  for (const domain of domains) {
    await resolveDomain('127.0.0.1', hnsd.RS_PORT, domain);
  }

  console.log('\nShutting down hnsd...');
  hnsd.stop(child);
  console.log('Done.');
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {};

  // Parse --hnsd-path option
  const pathIdx = args.indexOf('--hnsd-path');
  if (pathIdx !== -1) {
    opts.hnsdPath = args[pathIdx + 1];
    args.splice(pathIdx, 2);
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage:
  node check_hns.js sync                         Start hnsd (keep running)
  node check_hns.js query <domain> [domain ...]   Query running hnsd
  node check_hns.js <domain> [domain ...]          Auto: sync + query + stop

Options:
  --hnsd-path <path>   Path to hnsd binary (default: auto-detect)

Examples:
  node check_hns.js sync                          # Terminal 1: start & sync
  node check_hns.js query welcome.nb              # Terminal 2: query
  node check_hns.js nb shakeshift                 # Auto mode (waits for sync)

Build hnsd first:
  build_hnsd.cmd                                  # Windows
  ./build_hnsd.sh                                 # MSYS2 MINGW64 shell`);
    process.exit(0);
  }

  if (args[0] === 'sync') {
    await startSyncMode(opts);
  } else if (args[0] === 'query') {
    const domains = args.slice(1);
    if (domains.length === 0) {
      console.error('Usage: node check_hns.js query <domain> [domain ...]');
      process.exit(1);
    }
    await queryMode(domains, opts);
  } else {
    await autoMode(args, opts);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
