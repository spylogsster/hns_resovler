#!/usr/bin/env node
/**
 * Resolve Handshake (HNS) domains via hsd SPV node (direct blockchain resolution).
 *
 * Two modes:
 *   sync   - Start SPV node and keep it running until synced (run once, keep in background)
 *   query  - Query a running SPV node's recursive resolver
 *
 * Usage:
 *   node check_hns.js sync                        # Start SPV node, wait for full sync
 *   node check_hns.js query welcome.nb nb          # Query running node
 *   node check_hns.js query handshake.conference    # Query running node
 *
 * Quick test (starts node, syncs, queries, stops):
 *   node check_hns.js welcome.nb nb                 # Auto mode
 *
 * Requirements:
 *   npm install
 */

'use strict';

const SPVNode = require('hsd/lib/node/spvnode');
const {wire} = require('bns');
const {Message, Question, types} = wire;
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Fixed ports so sync and query modes can find each other
const NS_PORT = 15349;
const RS_PORT = 15350;
const HTTP_PORT = 15351;
const DATA_DIR = path.join(os.tmpdir(), 'hsd-spv-check');
const PID_FILE = path.join(DATA_DIR, 'spv.pid');

const RECORD_NAMES = {
  [types.A]: 'A', [types.AAAA]: 'AAAA', [types.NS]: 'NS',
  [types.CNAME]: 'CNAME', [types.TXT]: 'TXT', [types.SOA]: 'SOA',
  [types.DS]: 'DS', [types.MX]: 'MX', [types.SRV]: 'SRV',
};
const QUERY_TYPES = [types.A, types.AAAA, types.NS, types.CNAME, types.TXT];

// Codes that trigger direct NS fallback
const FALLBACK_CODES = new Set([2 /* SERVFAIL */, 5 /* REFUSED */]);

function queryDNS(host, port, domain, qtype, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const msg = new Message();
    msg.rd = true;
    const qs = new Question();
    qs.name = domain.endsWith('.') ? domain : domain + '.';
    qs.type = qtype;
    qs.class = 1;
    msg.question.push(qs);

    const buf = msg.encode();
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('TIMEOUT')); }, timeout);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      try { resolve(Message.decode(data)); } catch (e) { reject(e); }
    });
    sock.on('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
    sock.send(buf, 0, buf.length, port, host);
  });
}

function recordToString(rr) {
  const typeName = RECORD_NAMES[rr.type] || `TYPE${rr.type}`;
  let data = '';
  const d = rr.data;
  switch (rr.type) {
    case types.A: case types.AAAA: data = d.address; break;
    case types.NS: case types.CNAME: data = d.ns || d.target; break;
    case types.TXT: data = d.txt ? d.txt.map(t => `"${t}"`).join(' ') : ''; break;
    case types.SOA: data = `${d.ns} ${d.mbox} (serial=${d.serial})`; break;
    case types.MX: data = `${d.preference} ${d.mx}`; break;
    default: data = JSON.stringify(d);
  }
  return { typeName, data, ttl: rr.ttl };
}

/**
 * Extract the TLD from a domain (e.g. "shakeshift" -> "shakeshift",
 * "welcome.nb" -> "nb", "handshake.conference" -> "conference").
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
      // Check inline glue first
      if (glue[ns]) { result.push({ ns, ip: glue[ns] }); continue; }

      // No glue — the NS is likely an HNS name itself (e.g. a.namenode.).
      // Resolve its TLD via root to get synth/glue IPs, then query that NS
      // for the A record of the full NS name.
      const nsTLD = getTLD(ns.replace(/\.$/, ''));
      try {
        const tldRes = await queryDNS(rsHost, nsPort, nsTLD, types.A, 5000);
        // Check for glue/synth in additional
        for (const rr of tldRes.additional) {
          if (rr.type === types.A && rr.name.toLowerCase() === ns)
            glue[ns] = rr.data.address;
        }
        if (glue[ns]) { result.push({ ns, ip: glue[ns] }); continue; }

        // The NS TLD itself may have NS records with glue — resolve those
        // and query them for the NS hostname's A record.
        const nsGlue = {};
        for (const rr of tldRes.additional) {
          if (rr.type === types.A) nsGlue[rr.name.toLowerCase()] = rr.data.address;
        }
        const nsTLDNSNames = [];
        for (const rr of [...tldRes.authority, ...tldRes.answer]) {
          if (rr.type === types.NS) nsTLDNSNames.push(rr.data.ns.toLowerCase());
        }
        // Try to query each NS TLD's nameserver for the full NS hostname
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
          } catch (e) { /* try next */ }
        }
      } catch (e) { /* skip this NS */ }
    }
    return result;
  } catch (e) {
    return [];
  }
}

/**
 * Directly query external nameservers for a domain.
 * Tries each nameserver in order until one responds.
 */
async function queryNameserversDirect(nameservers, domain, qtype) {
  for (const {ns, ip} of nameservers) {
    try {
      return await queryDNS(ip, 53, domain, qtype, 8000);
    } catch (e) {
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
    const typeName = RECORD_NAMES[qtype] || `TYPE${qtype}`;
    try {
      const res = await queryDNS(rsHost, rsPort, domain, qtype);
      if (res.code !== 0) {
        if (qtype === QUERY_TYPES[0]) {
          const codeName = ['NOERROR','FORMERR','SERVFAIL','NXDOMAIN','NOTIMP','REFUSED'][res.code] || `CODE${res.code}`;
          console.log(`  RCODE: ${codeName} (recursive resolver)`);
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
        console.log(`  ${typeName.padEnd(6)} ERROR: ${e.message}`);
        if (e.message === 'TIMEOUT') break;
      }
    }
  }

  // Direct NS fallback: when the JS recursive resolver can't follow
  // HNS-native nameservers (e.g. a.namenode.), get NS+glue from the
  // authoritative root and query the nameservers directly.
  if (needFallback) {
    const tld = getTLD(domain);
    console.log(`  Falling back to direct NS query for TLD "${tld}"...`);

    const nameservers = await getRootReferral(rsHost, NS_PORT, tld);
    if (nameservers.length === 0) {
      console.log('  No nameservers with glue records found on-chain');
    } else {
      console.log(`  Nameservers: ${nameservers.map(n => `${n.ns} (${n.ip})`).join(', ')}`);

      for (const qtype of QUERY_TYPES) {
        const typeName = RECORD_NAMES[qtype] || `TYPE${qtype}`;
        const res = await queryNameserversDirect(nameservers, domain, qtype);
        if (!res) { if (qtype === QUERY_TYPES[0]) console.log('  All nameservers unreachable'); break; }

        if (res.code !== 0) {
          if (qtype === QUERY_TYPES[0]) {
            const codeName = ['NOERROR','FORMERR','SERVFAIL','NXDOMAIN','NOTIMP','REFUSED'][res.code] || `CODE${res.code}`;
            console.log(`  RCODE: ${codeName} (direct NS)`);
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

async function startSyncMode() {
  console.log('HNS SPV Node — Sync Mode');
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Recursive resolver will be at 127.0.0.1:${RS_PORT}`);
  console.log();

  const node = new SPVNode({
    network: 'main',
    memory: false,
    prefix: DATA_DIR,
    logLevel: 'warning',
    'ns-port': NS_PORT,
    'ns-host': '127.0.0.1',
    'rs-port': RS_PORT,
    'rs-host': '127.0.0.1',
    'http-port': HTTP_PORT,
    'http-host': '127.0.0.1',
    'no-auth': true,
    'no-sig0': true,
    listen: false,
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    await node.close();
    process.exit(0);
  });

  await node.ensure();
  await node.open();
  await node.connect();
  node.startSync();

  // Write PID file
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: RS_PORT }));

  console.log(`Chain height: ${node.chain.height}, synced: ${node.chain.synced}`);

  if (!node.chain.synced) {
    console.log('Syncing blockchain headers...');
    await new Promise((resolve) => {
      const check = setInterval(() => {
        const h = node.chain.height;
        const p = (node.chain.getProgress() * 100).toFixed(1);
        process.stdout.write(`\r  Height: ${h} (${p}%)   `);
        if (node.chain.synced) {
          clearInterval(check);
          console.log(`\r  Synced to height: ${h}              `);
          resolve();
        }
      }, 5000);
      node.chain.once('full', () => {
        clearInterval(check);
        console.log(`\r  Synced to height: ${node.chain.height}              `);
        resolve();
      });
    });
  }

  console.log(`\nSPV node fully synced at height ${node.chain.height}`);
  console.log(`Recursive resolver ready at 127.0.0.1:${RS_PORT}`);
  console.log('Press Ctrl+C to stop.\n');
  console.log('In another terminal, run:');
  console.log(`  node check_hns.js query welcome.nb handshake.conference`);

  // Keep alive
  await new Promise(() => {});
}

async function queryMode(domains) {
  // Check if SPV node is running
  let port = RS_PORT;
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    port = info.port;
  } catch (e) {
    // Use default port
  }

  // Quick connectivity check
  try {
    await queryDNS('127.0.0.1', port, '.', types.NS, 3000);
  } catch (e) {
    console.error(`Cannot reach SPV node at 127.0.0.1:${port}`);
    console.error('Start it first with: node check_hns.js sync');
    process.exit(1);
  }

  console.log(`HNS Domain Resolver (querying SPV node at 127.0.0.1:${port})`);
  console.log(`Domains: ${domains.join(', ')}\n`);

  for (const domain of domains) {
    await resolveDomain('127.0.0.1', port, domain);
  }
  console.log('\nDone.');
}

async function autoMode(domains) {
  console.log('HNS Domain Resolver (hsd SPV — direct blockchain resolution)');
  console.log(`Domains: ${domains.join(', ')}`);
  console.log(`Data dir: ${DATA_DIR}\n`);

  const node = new SPVNode({
    network: 'main',
    memory: false,
    prefix: DATA_DIR,
    logLevel: 'error',
    'ns-port': NS_PORT,
    'ns-host': '127.0.0.1',
    'rs-port': RS_PORT,
    'rs-host': '127.0.0.1',
    'http-port': HTTP_PORT,
    'http-host': '127.0.0.1',
    'no-auth': true,
    'no-sig0': true,
    listen: false,
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await node.close();
    process.exit(0);
  });

  console.log('Starting SPV node...');
  await node.ensure();
  await node.open();
  await node.connect();
  node.startSync();

  console.log(`Chain height: ${node.chain.height}, synced: ${node.chain.synced}`);

  if (!node.chain.synced) {
    console.log('Waiting for blockchain sync (first run takes ~30 min)...');
    console.log('Tip: use "node check_hns.js sync" in background for faster workflow.\n');

    await new Promise((resolve) => {
      const check = setInterval(() => {
        const h = node.chain.height;
        const p = (node.chain.getProgress() * 100).toFixed(1);
        process.stdout.write(`\r  Height: ${h} (${p}%)   `);
        if (node.chain.synced) {
          clearInterval(check);
          console.log(`\r  Synced to height: ${h}              `);
          resolve();
        }
      }, 5000);
      node.chain.once('full', () => {
        clearInterval(check);
        console.log(`\r  Synced to height: ${node.chain.height}              `);
        resolve();
      });
    });
  }

  console.log(`Chain synced (height ${node.chain.height}), resolving...\n`);

  for (const domain of domains) {
    await resolveDomain('127.0.0.1', RS_PORT, domain);
  }

  console.log('\nShutting down SPV node...');
  await node.close();
  console.log('Done.');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage:
  node check_hns.js sync                         Start SPV node (keep running)
  node check_hns.js query <domain> [domain ...]   Query running SPV node
  node check_hns.js <domain> [domain ...]          Auto: sync + query + stop

Examples:
  node check_hns.js sync                          # Terminal 1: start & sync
  node check_hns.js query welcome.nb              # Terminal 2: query
  node check_hns.js nb shakeshift                 # Auto mode (waits for sync)`);
    process.exit(0);
  }

  if (args[0] === 'sync') {
    await startSyncMode();
  } else if (args[0] === 'query') {
    const domains = args.slice(1);
    if (domains.length === 0) {
      console.error('Usage: node check_hns.js query <domain> [domain ...]');
      process.exit(1);
    }
    await queryMode(domains);
  } else {
    // Auto mode: all args are domains
    await autoMode(args);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
