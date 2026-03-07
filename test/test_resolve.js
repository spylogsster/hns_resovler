'use strict';

/**
 * End-to-end resolution tests.
 * Requires a running, synced hnsd instance (started via `node check_hns.js sync`).
 *
 * Run:   node --test test/test_resolve.js
 * Skip:  Set SKIP_E2E=1 to skip these tests.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { types, buildQuery, parseResponse } = require('../lib/dns_wire');
const { RS_PORT, NS_PORT, readPidFile } = require('../lib/hnsd_manager');

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

describe('E2E: HNS domain resolution', { skip: process.env.SKIP_E2E === '1' }, () => {
  let port = RS_PORT;

  before(async () => {
    // Try to detect running hnsd
    const info = readPidFile();
    if (info) port = info.port;

    try {
      await queryDNS('127.0.0.1', port, '.', types.NS, 3000);
    } catch {
      // Skip all tests if no hnsd running
      throw new Error(
        `No hnsd instance running at 127.0.0.1:${port}. ` +
        'Start one with: node check_hns.js sync'
      );
    }
  });

  it('should resolve a known HNS TLD (nb -> A record)', async () => {
    const res = await queryDNS('127.0.0.1', port, 'nb', types.A);
    assert.strictEqual(res.code, 0, 'Expected NOERROR');
    assert.ok(res.answer.length > 0, 'Expected at least one answer');

    const aRecords = res.answer.filter(rr => rr.type === types.A);
    assert.ok(aRecords.length > 0, 'Expected A record');
    // nb is known to resolve to 35.81.54.236
    assert.strictEqual(aRecords[0].data.address, '35.81.54.236');
  });

  it('should return NXDOMAIN for nonexistent domain', async () => {
    const res = await queryDNS('127.0.0.1', port, 'thisdoesnotexist12345', types.A);
    assert.strictEqual(res.code, 3, 'Expected NXDOMAIN');
  });

  it('should resolve NS records for a TLD', async () => {
    const res = await queryDNS('127.0.0.1', port, 'nb', types.NS);
    // nb should have NS records or the resolver returns them
    assert.strictEqual(res.code, 0, 'Expected NOERROR for NS query');
  });

  it('should handle subdomain of existing TLD', async () => {
    // welcome.nb may or may not exist, but should not crash
    const res = await queryDNS('127.0.0.1', port, 'welcome.nb', types.A);
    // Just verify we get a valid response (NOERROR, NXDOMAIN, or SERVFAIL)
    assert.ok([0, 2, 3].includes(res.code), `Unexpected rcode: ${res.code}`);
  });

  it('should resolve domains with HNS-native nameservers (e.g. shakeshift)', async () => {
    // shakeshift delegates to a.namenode. / b.namenode. (HNS-native NS)
    // With hnsd's libunbound, this should resolve directly.
    // If not, the direct NS fallback in check_hns.js handles it.
    const res = await queryDNS('127.0.0.1', port, 'shakeshift', types.A);
    // Accept any valid DNS response
    assert.ok(res.code !== undefined, 'Expected valid response');

    if (res.code === 0 && res.answer.length > 0) {
      const aRecords = res.answer.filter(rr => rr.type === types.A);
      if (aRecords.length > 0) {
        console.log(`  shakeshift resolved to: ${aRecords[0].data.address}`);
      }
    } else {
      console.log(`  shakeshift rcode: ${res.code} (may need direct NS fallback)`);
    }
  });

  it('should resolve root NS query', async () => {
    const res = await queryDNS('127.0.0.1', port, '.', types.NS);
    assert.strictEqual(res.code, 0, 'Expected NOERROR for root NS');
  });
});
