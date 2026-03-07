/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

/**
 * Local DNS proxy — forwards all queries to hnsd recursive resolver.
 *
 * hnsd resolves both Handshake (HNS) domains from the blockchain and
 * regular ICANN domains via embedded root zone fallback. This proxy
 * simply forwards UDP DNS packets from port 53 to hnsd's port.
 *
 * If hnsd doesn't respond within the timeout, falls back to an upstream
 * DNS server (default: 8.8.8.8) as a safety net.
 */

const dgram = require('dgram');
const os = require('os');

const UPSTREAM_DNS = '8.8.8.8';
const UPSTREAM_PORT = 53;
const FORWARD_TIMEOUT = 5000;

/**
 * Start the DNS proxy server.
 * @param {object} opts
 * @param {string} [opts.listenHost] - Address to listen on (default: 127.0.0.1)
 * @param {number} [opts.listenPort] - Port to listen on (default: 53)
 * @param {string} [opts.hnsdHost] - hnsd address (default: 127.0.0.1)
 * @param {number} [opts.hnsdPort] - hnsd recursive resolver port (default: 15350)
 * @param {string} [opts.upstreamDns] - Fallback DNS server (default: 8.8.8.8)
 * @param {boolean} [opts.quiet] - Suppress per-query logging
 * @returns {{ server: dgram.Socket, close: () => void }}
 */
function startProxy(opts = {}) {
  const listenHost = opts.listenHost || '127.0.0.1';
  const listenPort = opts.listenPort || 53;
  const hnsdHost = opts.hnsdHost || '127.0.0.1';
  const hnsdPort = opts.hnsdPort || 15350;
  const upstreamDns = opts.upstreamDns || UPSTREAM_DNS;
  const quiet = opts.quiet || false;

  const server = dgram.createSocket('udp4');
  let queryCount = 0;

  server.on('message', (msg, rinfo) => {
    queryCount++;
    const qname = extractQName(msg);
    if (!quiet) {
      process.stdout.write(`  [proxy] ${qname} from ${rinfo.address}:${rinfo.port}\n`);
    }

    forwardQuery(msg, hnsdHost, hnsdPort, (err, response) => {
      if (err) {
        // hnsd timeout/error — try upstream DNS as fallback
        if (!quiet) {
          process.stdout.write(`  [proxy] ${qname} hnsd timeout, trying upstream...\n`);
        }
        forwardQuery(msg, upstreamDns, UPSTREAM_PORT, (err2, response2) => {
          if (!err2 && response2) {
            server.send(response2, rinfo.port, rinfo.address);
          }
        });
        return;
      }
      server.send(response, rinfo.port, rinfo.address);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EACCES') {
      console.error(`\nPermission denied: cannot bind to port ${listenPort}.`);
      printElevationInstructions();
      process.exit(1);
    }
    console.error(`DNS proxy error: ${err.message}`);
  });

  server.bind(listenPort, listenHost, () => {
    console.log(`DNS proxy listening on ${listenHost}:${listenPort}`);
    console.log(`  Forwarding to hnsd at ${hnsdHost}:${hnsdPort}`);
    console.log(`  Upstream fallback: ${upstreamDns}`);
  });

  const close = () => {
    try { server.close(); } catch {}
  };

  return { server, close, getQueryCount: () => queryCount };
}

/**
 * Forward a DNS query via UDP and return the response.
 */
function forwardQuery(msg, host, port, cb) {
  const sock = dgram.createSocket('udp4');
  const timer = setTimeout(() => {
    sock.close();
    cb(new Error('timeout'));
  }, FORWARD_TIMEOUT);

  sock.on('message', (data) => {
    clearTimeout(timer);
    sock.close();
    cb(null, data);
  });

  sock.on('error', (err) => {
    clearTimeout(timer);
    sock.close();
    cb(err);
  });

  sock.send(msg, 0, msg.length, port, host);
}

/**
 * Extract the query name from a raw DNS packet (best-effort, for logging).
 */
function extractQName(buf) {
  if (buf.length < 13) return '?';
  let offset = 12; // skip header
  const labels = [];
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) break;
    if ((len & 0xc0) === 0xc0) break; // compression pointer
    offset++;
    if (offset + len > buf.length) break;
    labels.push(buf.subarray(offset, offset + len).toString('ascii'));
    offset += len;
  }
  return labels.join('.') || '?';
}

/**
 * Print platform-specific instructions for running with elevated privileges.
 */
function printElevationInstructions() {
  const platform = os.platform();
  console.error('');
  if (platform === 'win32') {
    console.error('On Windows, run your terminal as Administrator.');
  } else {
    console.error('Use sudo to bind to port 53:');
    console.error('  sudo node check_hns.js proxy');
  }
}

/**
 * Print platform-specific instructions for configuring system DNS.
 */
function printDnsInstructions() {
  const platform = os.platform();
  console.log('\nTo use HNS domains in your browser, set your system DNS to 127.0.0.1:');
  console.log('');

  if (platform === 'win32') {
    console.log('  Windows (PowerShell as Admin):');
    console.log('    netsh interface ip set dns "Wi-Fi" static 127.0.0.1');
    console.log('');
    console.log('  To restore:');
    console.log('    netsh interface ip set dns "Wi-Fi" dhcp');
  } else if (platform === 'darwin') {
    console.log('  macOS:');
    console.log('    sudo networksetup -setdnsservers Wi-Fi 127.0.0.1');
    console.log('');
    console.log('  To restore:');
    console.log('    sudo networksetup -setdnsservers Wi-Fi Empty');
  } else {
    console.log('  Linux (systemd-resolved):');
    console.log('    sudo resolvectl dns <interface> 127.0.0.1');
    console.log('');
    console.log('  Linux (resolv.conf):');
    console.log('    echo "nameserver 127.0.0.1" | sudo tee /etc/resolv.conf');
    console.log('');
    console.log('  To restore:');
    console.log('    sudo systemctl restart systemd-resolved');
  }
  console.log('');
}

module.exports = { startProxy, printDnsInstructions, printElevationInstructions };
