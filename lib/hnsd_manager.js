/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

/**
 * hnsd process lifecycle management.
 *
 * Spawns hnsd as a child process, monitors sync progress via stderr,
 * manages PID file, and provides clean shutdown.
 */

const { spawn, execSync } = require('child_process');
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
 * Kill any existing hnsd processes that may be holding ports.
 * @returns {boolean} Whether any processes were killed
 */
function killExisting() {
  try {
    if (os.platform() === 'win32') {
      const result = execSync('tasklist /FI "IMAGENAME eq hnsd.exe" /NH 2>nul', { encoding: 'utf8' });
      if (result.includes('hnsd.exe')) {
        execSync('taskkill /F /IM hnsd.exe 2>nul', { encoding: 'utf8' });
        return true;
      }
    } else {
      execSync('pkill -f hnsd 2>/dev/null || true', { encoding: 'utf8' });
      return true;
    }
  } catch {
    // Ignore errors
  }
  return false;
}

/**
 * Start hnsd as a child process.
 * If hnsd fails due to port conflict, automatically kills existing instances and retries.
 *
 * @param {object} opts
 * @param {string} [opts.hnsdPath] - Explicit path to hnsd binary
 * @param {number} [opts.rsPort] - Recursive resolver port (default: 15350)
 * @param {number} [opts.nsPort] - Authoritative NS port (default: 15349)
 * @param {number} [opts.poolSize] - Peer pool size (default: 8)
 * @param {string} [opts.prefix] - Data directory
 * @param {boolean} [opts.checkpoint] - Start from checkpoint (faster first sync)
 * @param {boolean} [opts.quiet] - Suppress stdout logging
 * @returns {{ child: ChildProcess, hnsdPath: string }}
 */
function start(opts = {}) {
  const hnsdPath = findBinary(opts.hnsdPath);
  const rsPort = opts.rsPort || RS_PORT;
  const nsPort = opts.nsPort || NS_PORT;
  const poolSize = opts.poolSize || 8;
  const prefix = opts.prefix || DATA_DIR;
  const checkpoint = opts.checkpoint !== false; // default: true

  // Ensure data dir exists
  fs.mkdirSync(prefix, { recursive: true });

  const args = [
    '-r', `127.0.0.1:${rsPort}`,
    '-n', `127.0.0.1:${nsPort}`,
    '-p', String(poolSize),
    '-x', prefix,
  ];

  if (checkpoint) {
    args.push('-t');
  }

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
 * Start hnsd with automatic retry on port conflict.
 * Detects "failed opening ns: EFAILURE" on stderr, kills existing hnsd, and retries.
 *
 * @param {object} opts - Same options as start()
 * @returns {Promise<{ child: ChildProcess, hnsdPath: string }>}
 */
function startWithRetry(opts = {}) {
  return new Promise((resolve, reject) => {
    const { child, hnsdPath } = start(opts);
    let stderrData = '';
    let settled = false;

    // Watch for early failure (port conflict)
    const failTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ child, hnsdPath });
      }
    }, 3000);

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('exit', (code) => {
      if (settled) return;

      if (code !== 0 && stderrData.includes('EFAILURE')) {
        clearTimeout(failTimer);
        settled = true;

        // Port conflict — kill existing hnsd and retry
        if (!opts.quiet) {
          console.log('\n  Port conflict: another hnsd is using the ports.');
          console.log('  Stopping existing hnsd...');
        }

        if (killExisting()) {
          // Wait for ports to free up
          setTimeout(() => {
            if (!opts.quiet) console.log('  Retrying...\n');
            try {
              resolve(start(opts));
            } catch (e) {
              reject(new Error(`Failed to restart hnsd: ${e.message}`));
            }
          }, 2000);
        } else {
          reject(new Error(
            `hnsd failed to start: ports ${opts.nsPort || NS_PORT}/${opts.rsPort || RS_PORT} are in use.\n` +
            'Another process is using these ports. Stop it and try again.'
          ));
        }
      } else if (code !== 0) {
        clearTimeout(failTimer);
        settled = true;

        // Other startup failure
        const stderr = stderrData.trim();
        let message = `hnsd exited with code ${code}.`;
        if (stderr.includes('ENOENT') || stderr.includes('not found')) {
          message += '\n  A required library (DLL/shared object) may be missing.';
          message += '\n  Try rebuilding: build_hnsd.cmd (Windows) or ./build_hnsd.sh (Mac/Linux)';
        } else if (stderr) {
          message += `\n  ${stderr.split('\n').slice(0, 3).join('\n  ')}`;
        }
        reject(new Error(message));
      }
    });

    child.on('error', (err) => {
      clearTimeout(failTimer);
      if (settled) return;
      settled = true;

      if (err.code === 'ENOENT') {
        reject(new Error(
          `Cannot execute hnsd binary: ${hnsdPath}\n` +
          '  The file exists but cannot be run. Check file permissions.\n' +
          '  On Linux/Mac: chmod +x bin/hnsd'
        ));
      } else {
        reject(new Error(`Failed to start hnsd: ${err.message}`));
      }
    });
  });
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
    let targetHeight = 0;
    let synced = false;
    let stderrBuf = '';
    const startTime = Date.now();
    let lastProgressTime = 0;

    const timer = setTimeout(() => {
      if (!synced) reject(new Error(`Sync timeout after ${timeout / 60000} minutes`));
    }, timeout);

    function printProgress() {
      const now = Date.now();
      const elapsed = Math.round((now - startTime) / 1000);
      let line = `  Syncing: height ${currentHeight}`;
      if (targetHeight > 0) {
        const pct = Math.min(100, (currentHeight / targetHeight * 100)).toFixed(1);
        line += ` / ${targetHeight} (${pct}%)`;
      }
      line += `  [${elapsed}s elapsed]`;
      console.log(line);
      lastProgressTime = now;
    }

    // Print progress every 10 seconds
    let progressInterval = null;
    if (showProgress) {
      progressInterval = setInterval(() => {
        if (synced || currentHeight === 0) return;
        printProgress();
      }, 10000);
    }

    function cleanup() {
      clearTimeout(timer);
      if (progressInterval) clearInterval(progressInterval);
    }

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

        // Parse target from "valid peer" messages or "best: 12345"
        const bestMatch = line.match(/best(?:height)?[:\s]+(\d+)/i);
        if (bestMatch) {
          const h = parseInt(bestMatch[1]);
          if (h > targetHeight) targetHeight = h;
        }
        const peerHeightMatch = line.match(/height[=:\s]+(\d+)/i);
        if (peerHeightMatch) {
          const h = parseInt(peerHeightMatch[1]);
          if (h > targetHeight && h > currentHeight) targetHeight = h;
        }

        if (line.includes('chain is fully synced')) {
          synced = true;
          cleanup();
          if (showProgress) {
            console.log(`  Synced to height: ${currentHeight}`);
          }
          resolve(currentHeight);
          return;
        }
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`hnsd process error: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      cleanup();
      if (!synced) {
        let msg = 'hnsd stopped unexpectedly before completing sync.';
        if (code === 3) {
          msg += '\n  This usually means the ports are already in use by another hnsd instance.';
          msg += '\n  Use "sync" or "proxy" mode — they auto-detect and reuse running instances.';
        } else if (signal) {
          msg += `\n  Killed by signal: ${signal}`;
        } else {
          msg += `\n  Exit code: ${code}`;
        }
        reject(new Error(msg));
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
  startWithRetry,
  killExisting,
  waitForSync,
  waitForReady,
  writePidFile,
  readPidFile,
  removePidFile,
  stop,
};
