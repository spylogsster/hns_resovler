/* Copyright (c) 2026 Sergei P <spylogsster@gmail.com>
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

/**
 * DANE (DNS-based Authentication of Named Entities) verification.
 *
 * Queries TLSA records for a domain and verifies the server's TLS certificate
 * against the published TLSA data. This replaces traditional CA-based validation
 * for Handshake domains where certificate authority is derived from the blockchain.
 *
 * Uses only Node.js builtins (tls, crypto, dgram) — zero external dependencies.
 */

const tls = require('tls');
const crypto = require('crypto');
const dgram = require('dgram');
const { types, buildQuery, parseResponse } = require('./dns_wire');

// TLSA usage field names
const USAGE_NAMES = {
  0: 'PKIX-TA',
  1: 'PKIX-EE',
  2: 'DANE-TA',
  3: 'DANE-EE',
};

// TLSA selector field names
const SELECTOR_NAMES = {
  0: 'Full certificate',
  1: 'SubjectPublicKeyInfo',
};

// TLSA matching type field names
const MATCHING_NAMES = {
  0: 'Exact',
  1: 'SHA-256',
  2: 'SHA-512',
};

/**
 * Query TLSA records for a domain+port via a DNS resolver.
 *
 * @param {string} resolverHost - DNS resolver address (e.g. '127.0.0.1')
 * @param {number} resolverPort - DNS resolver port (e.g. 15350)
 * @param {string} domain - Target domain (e.g. 'example')
 * @param {number} [targetPort=443] - Target TLS port
 * @param {number} [timeout=10000] - Query timeout in ms
 * @returns {Promise<object[]>} Array of parsed TLSA record data objects
 */
function queryTLSA(resolverHost, resolverPort, domain, targetPort = 443, timeout = 10000) {
  const tlsaName = `_${targetPort}._tcp.${domain}`;

  return new Promise((resolve, reject) => {
    const buf = buildQuery(tlsaName, types.TLSA);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('TLSA query timeout'));
    }, timeout);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      try {
        const res = parseResponse(data);
        const records = res.answer
          .filter(rr => rr.type === types.TLSA)
          .map(rr => ({ ...rr.data, ttl: rr.ttl, name: rr.name }));
        resolve(records);
      } catch (e) {
        reject(e);
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });

    sock.send(buf, 0, buf.length, resolverPort, resolverHost);
  });
}

/**
 * Extract certificate data based on the TLSA selector field.
 *
 * @param {Buffer} rawCert - DER-encoded certificate (from getPeerCertificate().raw)
 * @param {number} selector - 0 = full cert, 1 = SubjectPublicKeyInfo
 * @returns {Buffer} The selected certificate data
 */
function extractCertData(rawCert, selector) {
  if (selector === 0) {
    return rawCert;
  }
  if (selector === 1) {
    // Extract SubjectPublicKeyInfo from DER certificate.
    // Use Node's crypto to get the public key in DER/SPKI format.
    const cert = new crypto.X509Certificate(rawCert);
    const pubKey = cert.publicKey;
    return pubKey.export({ type: 'spki', format: 'der' });
  }
  return rawCert;
}

/**
 * Compute the hash of certificate data based on the TLSA matching type.
 *
 * @param {Buffer} data - Certificate data (full cert or SPKI)
 * @param {number} matchingType - 0 = exact, 1 = SHA-256, 2 = SHA-512
 * @returns {string} Hex string of the result
 */
function computeMatch(data, matchingType) {
  switch (matchingType) {
    case 0:
      return data.toString('hex');
    case 1:
      return crypto.createHash('sha256').update(data).digest('hex');
    case 2:
      return crypto.createHash('sha512').update(data).digest('hex');
    default:
      return data.toString('hex');
  }
}

/**
 * Connect to a server via TLS and retrieve its certificate.
 *
 * @param {string} host - IP address or hostname to connect to
 * @param {number} port - TLS port
 * @param {string} servername - SNI hostname
 * @param {number} [timeout=10000] - Connection timeout in ms
 * @returns {Promise<Buffer>} DER-encoded server certificate
 */
function fetchCertificate(host, port, servername, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => {
      if (socket) socket.destroy();
      reject(new Error('TLS connection timeout'));
    }, timeout);

    socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false, // DANE replaces CA validation
    }, () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate(true);
      socket.destroy();
      if (!cert || !cert.raw) {
        reject(new Error('No certificate received from server'));
        return;
      }
      resolve(cert.raw);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`TLS connection failed: ${err.message}`));
    });
  });
}

/**
 * Verify a server's TLS certificate against TLSA records.
 *
 * @param {string} ip - Server IP address
 * @param {string} domain - Domain name (for SNI)
 * @param {number} port - TLS port
 * @param {object[]} tlsaRecords - Parsed TLSA records from queryTLSA()
 * @returns {Promise<object>} Verification result
 */
async function verifyDANE(ip, domain, port, tlsaRecords) {
  if (!tlsaRecords || tlsaRecords.length === 0) {
    return { verified: false, error: 'No TLSA records' };
  }

  let rawCert;
  try {
    rawCert = await fetchCertificate(ip, port, domain);
  } catch (e) {
    return { verified: false, error: e.message };
  }

  for (const tlsa of tlsaRecords) {
    const { usage, selector, matchingType, certData } = tlsa;

    // RFC 6698: valid usage values are 0-3
    if (usage < 0 || usage > 3) {
      continue;
    }

    try {
      const selectedData = extractCertData(rawCert, selector);
      const computed = computeMatch(selectedData, matchingType);

      if (computed === certData.toLowerCase()) {
        // PKIX-TA (0) and PKIX-EE (1) require full CA chain validation per RFC 6698.
        // We only perform hash matching here, so flag PKIX matches as partial.
        const isPKIX = usage === 0 || usage === 1;
        return {
          verified: true,
          usage,
          selector,
          matchingType,
          usageName: USAGE_NAMES[usage] || `USAGE${usage}`,
          selectorName: SELECTOR_NAMES[selector] || `SEL${selector}`,
          matchingName: MATCHING_NAMES[matchingType] || `MATCH${matchingType}`,
          pkixPartial: isPKIX,
        };
      }
    } catch {
      // Try next TLSA record
    }
  }

  return {
    verified: false,
    error: 'Certificate does not match any TLSA record',
  };
}

/**
 * Format DANE verification result for console output.
 *
 * @param {object} result - Result from verifyDANE()
 * @returns {string} Formatted string
 */
function formatDANEResult(result) {
  if (result.verified) {
    const base = `VERIFIED - certificate matches TLSA record (${result.matchingName}, ${result.usageName})`;
    if (result.pkixPartial) {
      return `${base} [PKIX: hash match only, CA chain not validated]`;
    }
    return base;
  }
  return `FAILED - ${result.error}`;
}

module.exports = {
  queryTLSA,
  verifyDANE,
  formatDANEResult,
  fetchCertificate,
  extractCertData,
  computeMatch,
  USAGE_NAMES,
  SELECTOR_NAMES,
  MATCHING_NAMES,
};
