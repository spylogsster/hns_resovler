/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

/**
 * Local proxy servers for HNS domain browsing.
 *
 * Two modes:
 *   HTTP proxy (default) — no root required, works on any high port.
 *     Browser connects via HTTP proxy settings. Handles both HTTP requests
 *     and HTTPS via CONNECT tunnels. Resolves all domains through hnsd.
 *
 *   DNS proxy (--dns flag) — requires root/admin for port 53.
 *     Forwards raw UDP DNS packets to hnsd. System DNS must be set to 127.0.0.1.
 *
 * hnsd resolves both Handshake (HNS) domains from the blockchain and
 * regular ICANN domains via embedded root zone fallback.
 */

const dgram = require('dgram');
const http = require('http');
const net = require('net');
const os = require('os');
const { buildQuery, parseResponse, types } = require('./dns_wire');

const UPSTREAM_DNS = '8.8.8.8';
const UPSTREAM_PORT = 53;
const FORWARD_TIMEOUT = 5000;
const DEFAULT_HTTP_PORT = 8053;
const DEFAULT_DNS_PORT = 53;

// --- DNS resolution via hnsd ---

/**
 * Resolve a domain to an IP address via hnsd.
 */
function resolveViaHnsd(domain, hnsdHost, hnsdPort) {
  return new Promise((resolve, reject) => {
    const buf = buildQuery(domain, types.A);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('hnsd timeout'));
    }, FORWARD_TIMEOUT);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      try {
        const res = parseResponse(data);
        const addrs = res.answer.filter(r => r.type === types.A).map(r => r.data.address);
        if (addrs.length > 0) resolve(addrs[0]);
        else reject(new Error(`no A record for ${domain}`));
      } catch (e) {
        reject(e);
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });

    sock.send(buf, 0, buf.length, hnsdPort, hnsdHost);
  });
}

// --- HTTP proxy (no root required) ---

/**
 * Start an HTTP proxy server with CONNECT support.
 * Resolves all domains through hnsd. No root/admin required.
 *
 * @param {object} opts
 * @param {number} [opts.port] - Listen port (default: 8053)
 * @param {string} [opts.hnsdHost] - hnsd address (default: 127.0.0.1)
 * @param {number} [opts.hnsdPort] - hnsd recursive resolver port (default: 15350)
 * @param {boolean} [opts.quiet] - Suppress per-request logging
 * @returns {{ server: http.Server, close: () => void }}
 */
function startHttpProxy(opts = {}) {
  const port = opts.port || DEFAULT_HTTP_PORT;
  const hnsdHost = opts.hnsdHost || '127.0.0.1';
  const hnsdPort = opts.hnsdPort || 15350;
  const quiet = opts.quiet || false;

  const server = http.createServer(async (req, res) => {
    // HTTP (non-CONNECT) proxy request
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const hostname = url.hostname;
    if (!quiet) process.stdout.write(`  [proxy] HTTP ${hostname}${url.pathname}\n`);

    try {
      const ip = await resolveViaHnsd(hostname, hnsdHost, hnsdPort);
      const proxyReq = http.request({
        hostname: ip,
        port: parseInt(url.port) || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: url.host },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => {
        if (!quiet) process.stdout.write(`  [proxy] HTTP error ${hostname}: ${e.message}\n`);
        res.writeHead(502);
        res.end('Bad Gateway');
      });
      req.pipe(proxyReq);
    } catch (e) {
      if (!quiet) process.stdout.write(`  [proxy] DNS fail ${hostname}: ${e.message}\n`);
      res.writeHead(502);
      res.end(`DNS resolution failed: ${e.message}`);
    }
  });

  // HTTPS CONNECT tunnel
  server.on('connect', async (req, clientSocket, head) => {
    const [hostname, portStr] = req.url.split(':');
    const targetPort = parseInt(portStr) || 443;

    if (!quiet) process.stdout.write(`  [proxy] CONNECT ${hostname}:${targetPort}\n`);

    try {
      const ip = await resolveViaHnsd(hostname, hnsdHost, hnsdPort);
      const serverSocket = net.connect(targetPort, ip, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      serverSocket.on('error', () => {
        clientSocket.end();
      });
      clientSocket.on('error', () => {
        serverSocket.end();
      });
    } catch (e) {
      if (!quiet) process.stdout.write(`  [proxy] CONNECT fail ${hostname}: ${e.message}\n`);
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.log(`Port ${port} is in use, trying ${nextPort}...`);
      server.listen(nextPort, '127.0.0.1', () => {
        console.log(`HTTP proxy listening on 127.0.0.1:${nextPort}`);
        console.log(`  Resolving domains via hnsd at 127.0.0.1:${hnsdPort}`);
      });
    } else {
      console.error(`HTTP proxy error: ${err.message}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`HTTP proxy listening on 127.0.0.1:${port}`);
    console.log(`  Resolving domains via hnsd at 127.0.0.1:${hnsdPort}`);
  });

  const close = () => {
    try { server.close(); } catch {}
  };

  return { server, close };
}

// --- DNS proxy (requires root/admin for port 53) ---

/**
 * Start a DNS proxy server (UDP forwarder).
 * @param {object} opts
 * @param {string} [opts.listenHost] - Address to listen on (default: 127.0.0.1)
 * @param {number} [opts.listenPort] - Port to listen on (default: 53)
 * @param {string} [opts.hnsdHost] - hnsd address (default: 127.0.0.1)
 * @param {number} [opts.hnsdPort] - hnsd recursive resolver port (default: 15350)
 * @param {string} [opts.upstreamDns] - Fallback DNS server (default: 8.8.8.8)
 * @param {boolean} [opts.quiet] - Suppress per-query logging
 * @returns {{ server: dgram.Socket, close: () => void }}
 */
function startDnsProxy(opts = {}) {
  const listenHost = opts.listenHost || '127.0.0.1';
  const listenPort = opts.listenPort || DEFAULT_DNS_PORT;
  const hnsdHost = opts.hnsdHost || '127.0.0.1';
  const hnsdPort = opts.hnsdPort || 15350;
  const upstreamDns = opts.upstreamDns || UPSTREAM_DNS;
  const quiet = opts.quiet || false;

  const server = dgram.createSocket('udp4');

  server.on('message', (msg, rinfo) => {
    const qname = extractQName(msg);
    if (!quiet) {
      process.stdout.write(`  [dns] ${qname} from ${rinfo.address}:${rinfo.port}\n`);
    }

    forwardQuery(msg, hnsdHost, hnsdPort, (err, response) => {
      if (err) {
        if (!quiet) {
          process.stdout.write(`  [dns] ${qname} hnsd timeout, trying upstream...\n`);
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

  return { server, close };
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

// --- Instructions ---

function printElevationInstructions() {
  const platform = os.platform();
  console.error('');
  if (platform === 'win32') {
    console.error('On Windows, run your terminal as Administrator.');
  } else {
    console.error('Use sudo to bind to port 53:');
    console.error('  sudo node check_hns.js proxy --dns');
  }
}

function printHttpProxyInstructions(port) {
  const platform = os.platform();
  console.log('\nConfigure your browser to use this proxy:');
  console.log('');

  if (platform === 'win32') {
    console.log('  Windows:');
    console.log('    Settings > Network & Internet > Proxy > Manual proxy setup');
    console.log(`    Address: 127.0.0.1  Port: ${port}`);
    console.log('');
    console.log('  Or launch Chrome with:');
    console.log(`    chrome.exe --proxy-server="http://127.0.0.1:${port}"`);
  } else if (platform === 'darwin') {
    console.log('  macOS:');
    console.log('    System Settings > Network > Wi-Fi > Proxies > Web Proxy (HTTP)');
    console.log(`    Server: 127.0.0.1  Port: ${port}`);
    console.log('    Also set Secure Web Proxy (HTTPS) to the same.');
    console.log('');
    console.log('  Or launch Chrome with:');
    console.log(`    open -a "Google Chrome" --args --proxy-server="http://127.0.0.1:${port}"`);
  } else {
    console.log('  Linux:');
    console.log(`    export http_proxy=http://127.0.0.1:${port}`);
    console.log(`    export https_proxy=http://127.0.0.1:${port}`);
    console.log('');
    console.log('  Or launch Chrome with:');
    console.log(`    google-chrome --proxy-server="http://127.0.0.1:${port}"`);
  }

  console.log('');
  console.log('  Then navigate to http://nb/ or http://shakeshift/ in your browser.');
  console.log('');
}

function printDnsProxyInstructions() {
  const platform = os.platform();
  console.log('\nSet your system DNS to 127.0.0.1:');
  console.log('');

  if (platform === 'win32') {
    console.log('  Windows (PowerShell as Admin):');
    console.log('    netsh interface ip set dns "Wi-Fi" static 127.0.0.1');
    console.log('  To restore:');
    console.log('    netsh interface ip set dns "Wi-Fi" dhcp');
  } else if (platform === 'darwin') {
    console.log('  macOS:');
    console.log('    sudo networksetup -setdnsservers Wi-Fi 127.0.0.1');
    console.log('  To restore:');
    console.log('    sudo networksetup -setdnsservers Wi-Fi Empty');
  } else {
    console.log('  Linux:');
    console.log('    sudo resolvectl dns <interface> 127.0.0.1');
    console.log('  To restore:');
    console.log('    sudo systemctl restart systemd-resolved');
  }
  console.log('');
}

module.exports = {
  startHttpProxy,
  startDnsProxy,
  printHttpProxyInstructions,
  printDnsProxyInstructions,
  resolveViaHnsd,
  DEFAULT_HTTP_PORT,
  DEFAULT_DNS_PORT,
};
