'use strict';

/**
 * hnsd process lifecycle management.
 *
 * Spawns hnsd as a child process, monitors sync progress via stderr,
 * manages PID file, and provides clean shutdown.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { buildQuery, parseResponse, types } = require('./dns_wire');

const NS_PORT = 15349;
const RS_PORT = 15350;
const DATA_DIR = path.join(os.tmpdir(), 'hnsd-spv-check');
const PID_FILE = path.join(DATA_DIR, 'hnsd.pid');

/**
 * Search for the hnsd binary in standard locations.
 * @param {string} [explicitPath] - User-specified path
 * @returns {string} Path to hnsd binary
 * @throws {Error} If binary not found
 */
function findBinary(explicitPath) {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) return explicitPath;
    throw new Error(`hnsd not found at: ${explicitPath}`);
  }

  const scriptDir = path.resolve(__dirname, '..');
  const candidates = [
    path.join(scriptDir, 'bin', 'hnsd.exe'),
    path.join(scriptDir, 'bin', 'hnsd'),
    path.join(scriptDir, 'vendor', 'hnsd', 'hnsd.exe'),
    path.join(scriptDir, 'vendor', 'hnsd', 'hnsd'),
  ];

  // Also check PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    candidates.push(path.join(dir, 'hnsd.exe'));
    candidates.push(path.join(dir, 'hnsd'));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    'hnsd binary not found. Build it first:\n' +
    '  build_hnsd.cmd   (Windows)\n' +
    '  ./build_hnsd.sh  (MSYS2 MINGW64 shell)\n' +
    `\nSearched: ${candidates.slice(0, 4).join(', ')}`
  );
}

/**
 * Start hnsd as a child process.
 * @param {object} opts
 * @param {string} [opts.hnsdPath] - Explicit path to hnsd binary
 * @param {number} [opts.rsPort] - Recursive resolver port (default: 15350)
 * @param {number} [opts.nsPort] - Authoritative NS port (default: 15349)
 * @param {number} [opts.poolSize] - Peer pool size (default: 8)
 * @param {string} [opts.prefix] - Data directory
 * @param {boolean} [opts.quiet] - Suppress stdout logging
 * @returns {{ child: ChildProcess, hnsdPath: string }}
 */
function start(opts = {}) {
  const hnsdPath = findBinary(opts.hnsdPath);
  const rsPort = opts.rsPort || RS_PORT;
  const nsPort = opts.nsPort || NS_PORT;
  const poolSize = opts.poolSize || 8;
  const prefix = opts.prefix || DATA_DIR;

  // Ensure data dir exists
  fs.mkdirSync(prefix, { recursive: true });

  const args = [
    '-r', `127.0.0.1:${rsPort}`,
    '-n', `127.0.0.1:${nsPort}`,
    '-p', String(poolSize),
    '-x', prefix,
  ];

  if (!opts.quiet) {
    console.log(`Starting hnsd: ${hnsdPath}`);
    console.log(`  Recursive resolver: 127.0.0.1:${rsPort}`);
    console.log(`  Authoritative NS:   127.0.0.1:${nsPort}`);
    console.log(`  Data dir: ${prefix}`);
  }

  const child = spawn(hnsdPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { child, hnsdPath };
}

/**
 * Wait for hnsd to fully sync the blockchain.
 * Parses hnsd stderr for sync progress messages.
 *
 * @param {ChildProcess} child - hnsd process
 * @param {object} [opts]
 * @param {boolean} [opts.showProgress] - Print progress updates
 * @param {number} [opts.timeout] - Timeout in ms (default: 45 min)
 * @returns {Promise<number>} Final chain height
 */
function waitForSync(child, opts = {}) {
  const showProgress = opts.showProgress !== false;
  const timeout = opts.timeout || 45 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let currentHeight = 0;
    let synced = false;
    let stderrBuf = '';

    const timer = setTimeout(() => {
      if (!synced) reject(new Error(`Sync timeout after ${timeout / 60000} minutes`));
    }, timeout);

    child.stderr.on('data', (data) => {
      stderrBuf += data.toString();

      // Process complete lines
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        // Parse height from "chain (12345): ..." or "new height: 12345"
        const heightMatch = line.match(/chain \((\d+)\)/);
        if (heightMatch) currentHeight = parseInt(heightMatch[1]);

        const newHeightMatch = line.match(/new height:\s*(\d+)/);
        if (newHeightMatch) currentHeight = parseInt(newHeightMatch[1]);

        if (showProgress && currentHeight > 0 && line.includes('chain')) {
          process.stdout.write(`\r  Height: ${currentHeight}   `);
        }

        if (line.includes('chain is fully synced')) {
          synced = true;
          clearTimeout(timer);
          if (showProgress) {
            process.stdout.write(`\r  Synced to height: ${currentHeight}              \n`);
          }
          resolve(currentHeight);
          return;
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`hnsd process error: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!synced) {
        reject(new Error(`hnsd exited before sync (code=${code}, signal=${signal})`));
      }
    });
  });
}

/**
 * Wait for hnsd DNS resolver to become responsive.
 * hnsd on Windows may not respond to DNS during initial sync (issue #128).
 *
 * @param {number} port - Resolver port
 * @param {number} [timeout] - Timeout in ms (default: 30s)
 * @returns {Promise<void>}
 */
function waitForReady(port, timeout = 30000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    async function poll() {
      if (Date.now() - start > timeout) {
        return reject(new Error('hnsd resolver not responding after sync'));
      }
      try {
        await queryTest(port);
        resolve();
      } catch {
        setTimeout(poll, 1000);
      }
    }
    poll();
  });
}

/**
 * Send a test DNS query to check if resolver is responsive.
 */
function queryTest(port) {
  return new Promise((resolve, reject) => {
    const buf = buildQuery('.', types.NS, 0x0001);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 3000);

    sock.on('message', () => {
      clearTimeout(timer);
      sock.close();
      resolve();
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });
    sock.send(buf, 0, buf.length, port, '127.0.0.1');
  });
}

/**
 * Write PID file for query mode to find running hnsd.
 */
function writePidFile(pid, port) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid, port, ts: Date.now() }));
}

/**
 * Read PID file. Returns null if not found.
 */
function readPidFile() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove PID file.
 */
function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

/**
 * Stop hnsd process gracefully.
 */
function stop(child) {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    // Force kill after 5 seconds
    setTimeout(() => {
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000);
  }
  removePidFile();
}

module.exports = {
  NS_PORT,
  RS_PORT,
  DATA_DIR,
  PID_FILE,
  findBinary,
  start,
  waitForSync,
  waitForReady,
  writePidFile,
  readPidFile,
  removePidFile,
  stop,
};
