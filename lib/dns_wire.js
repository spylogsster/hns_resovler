/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

/**
 * Minimal DNS wire protocol encoder/decoder.
 * Replaces the `bns` npm dependency with ~200 lines of self-contained code.
 *
 * Supports: A, AAAA, NS, CNAME, TXT, SOA, MX, SRV, DS record types.
 * Handles DNS name compression (pointers).
 */

// DNS record types
const types = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  DS: 43,
};

// DNS response codes
const rcodes = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
};

// Human-readable type names
const typeNames = {};
for (const [name, val] of Object.entries(types)) typeNames[val] = name;

/**
 * Build a DNS query packet.
 * @param {string} domain - Domain name to query (e.g. "nb" or "nb.")
 * @param {number} qtype - Query type (from types.*)
 * @param {number} [id] - Query ID (random if omitted)
 * @returns {Buffer} DNS wire format query
 */
function buildQuery(domain, qtype, id) {
  if (!domain.endsWith('.')) domain += '.';
  id = id ?? ((Math.random() * 0xffff) | 0);

  const labels = encodeName(domain);

  // Header (12) + Question (labels + 4)
  const buf = Buffer.alloc(12 + labels.length + 4);
  let off = 0;

  // Header
  buf.writeUInt16BE(id, off); off += 2;          // ID
  buf.writeUInt16BE(0x0100, off); off += 2;       // Flags: RD=1
  buf.writeUInt16BE(1, off); off += 2;            // QDCOUNT
  buf.writeUInt16BE(0, off); off += 2;            // ANCOUNT
  buf.writeUInt16BE(0, off); off += 2;            // NSCOUNT
  buf.writeUInt16BE(0, off); off += 2;            // ARCOUNT

  // Question
  labels.copy(buf, off); off += labels.length;
  buf.writeUInt16BE(qtype, off); off += 2;        // QTYPE
  buf.writeUInt16BE(1, off); off += 2;            // QCLASS = IN

  return buf;
}

/**
 * Parse a DNS response packet.
 * @param {Buffer} buf - DNS wire format response
 * @returns {object} Parsed response with header, question, answer, authority, additional
 */
function parseResponse(buf) {
  let off = 0;

  // Header
  const id = buf.readUInt16BE(off); off += 2;
  const flags = buf.readUInt16BE(off); off += 2;
  const qdcount = buf.readUInt16BE(off); off += 2;
  const ancount = buf.readUInt16BE(off); off += 2;
  const nscount = buf.readUInt16BE(off); off += 2;
  const arcount = buf.readUInt16BE(off); off += 2;

  const code = flags & 0x0f;
  const rd = !!(flags & 0x0100);
  const ra = !!(flags & 0x0080);
  const aa = !!(flags & 0x0400);

  // Skip questions
  for (let i = 0; i < qdcount; i++) {
    off = skipName(buf, off);
    off += 4; // QTYPE + QCLASS
  }

  const answer = [];
  const authority = [];
  const additional = [];

  for (let i = 0; i < ancount; i++) {
    const { rr, offset } = parseRR(buf, off);
    answer.push(rr);
    off = offset;
  }
  for (let i = 0; i < nscount; i++) {
    const { rr, offset } = parseRR(buf, off);
    authority.push(rr);
    off = offset;
  }
  for (let i = 0; i < arcount; i++) {
    const { rr, offset } = parseRR(buf, off);
    additional.push(rr);
    off = offset;
  }

  return { id, code, flags, rd, ra, aa, answer, authority, additional };
}

// --- Encoding helpers ---

function encodeName(domain) {
  const parts = domain.replace(/\.$/, '').split('.');
  const bufs = [];
  for (const label of parts) {
    const enc = Buffer.from(label, 'ascii');
    bufs.push(Buffer.from([enc.length]), enc);
  }
  bufs.push(Buffer.from([0])); // root label
  return Buffer.concat(bufs);
}

// --- Decoding helpers ---

function decodeName(buf, off) {
  const labels = [];
  let jumped = false;
  let savedOff = -1;

  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) {
      off++;
      break;
    }
    // Compression pointer
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) savedOff = off + 2;
      jumped = true;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    off++;
    labels.push(buf.subarray(off, off + len).toString('ascii'));
    off += len;
  }

  const name = labels.join('.') + '.';
  return { name, offset: jumped ? savedOff : off };
}

function skipName(buf, off) {
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += 1 + len;
  }
  return off;
}

function parseRR(buf, off) {
  const { name, offset: nameEnd } = decodeName(buf, off);
  off = nameEnd;

  const type = buf.readUInt16BE(off); off += 2;
  const cls = buf.readUInt16BE(off); off += 2;
  const ttl = buf.readUInt32BE(off); off += 4;
  const rdlen = buf.readUInt16BE(off); off += 2;

  const data = parseRData(buf, off, type, rdlen);
  off += rdlen;

  return { rr: { name, type, class: cls, ttl, data }, offset: off };
}

function parseRData(buf, off, type, rdlen) {
  switch (type) {
    case types.A:
      if (rdlen < 4) return { address: '?' };
      return { address: `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}` };

    case types.AAAA: {
      if (rdlen < 16) return { address: '?' };
      const parts = [];
      for (let i = 0; i < 16; i += 2)
        parts.push(buf.readUInt16BE(off + i).toString(16));
      // Compress consecutive zero groups
      const address = parts.join(':').replace(/(^|:)(0(:0)*)(:|$)/, '::');
      return { address };
    }

    case types.NS:
      return { ns: decodeName(buf, off).name };

    case types.CNAME:
      return { target: decodeName(buf, off).name };

    case types.SOA: {
      const { name: ns, offset: o1 } = decodeName(buf, off);
      const { name: mbox, offset: o2 } = decodeName(buf, o1);
      const serial = buf.readUInt32BE(o2);
      return { ns, mbox, serial };
    }

    case types.MX: {
      const preference = buf.readUInt16BE(off);
      const { name: mx } = decodeName(buf, off + 2);
      return { preference, mx };
    }

    case types.TXT: {
      const txt = [];
      let pos = off;
      const end = off + rdlen;
      while (pos < end) {
        const slen = buf[pos++];
        txt.push(buf.subarray(pos, pos + slen).toString('utf8'));
        pos += slen;
      }
      return { txt };
    }

    case types.SRV: {
      const priority = buf.readUInt16BE(off);
      const weight = buf.readUInt16BE(off + 2);
      const port = buf.readUInt16BE(off + 4);
      const { name: target } = decodeName(buf, off + 6);
      return { priority, weight, port, target };
    }

    case types.DS: {
      const keytag = buf.readUInt16BE(off);
      const algorithm = buf[off + 2];
      const digestType = buf[off + 3];
      const digest = buf.subarray(off + 4, off + rdlen).toString('hex');
      return { keytag, algorithm, digestType, digest };
    }

    default:
      return { raw: buf.subarray(off, off + rdlen).toString('hex') };
  }
}

// --- Utility ---

function rcodeName(code) {
  return rcodes[code] || `CODE${code}`;
}

function typeName(type) {
  return typeNames[type] || `TYPE${type}`;
}

function recordToString(rr) {
  const tn = typeName(rr.type);
  let data = '';
  const d = rr.data;
  switch (rr.type) {
    case types.A: case types.AAAA: data = d.address; break;
    case types.NS: data = d.ns; break;
    case types.CNAME: data = d.target; break;
    case types.TXT: data = d.txt ? d.txt.map(t => `"${t}"`).join(' ') : ''; break;
    case types.SOA: data = `${d.ns} ${d.mbox} (serial=${d.serial})`; break;
    case types.MX: data = `${d.preference} ${d.mx}`; break;
    default: data = JSON.stringify(d);
  }
  return { typeName: tn, data, ttl: rr.ttl };
}

module.exports = {
  types,
  rcodes,
  typeNames,
  buildQuery,
  parseResponse,
  rcodeName,
  typeName,
  recordToString,
};
