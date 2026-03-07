/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { types, buildQuery, parseResponse, rcodeName, typeName, recordToString } = require('../lib/dns_wire');

describe('dns_wire', () => {
  describe('buildQuery', () => {
    it('should build a valid DNS query for A record', () => {
      const buf = buildQuery('example.com', types.A, 0x1234);

      // Header
      assert.strictEqual(buf.readUInt16BE(0), 0x1234, 'ID');
      assert.strictEqual(buf.readUInt16BE(2), 0x0100, 'Flags RD=1');
      assert.strictEqual(buf.readUInt16BE(4), 1, 'QDCOUNT');
      assert.strictEqual(buf.readUInt16BE(6), 0, 'ANCOUNT');
      assert.strictEqual(buf.readUInt16BE(8), 0, 'NSCOUNT');
      assert.strictEqual(buf.readUInt16BE(10), 0, 'ARCOUNT');

      // Question: \x07example\x03com\x00
      assert.strictEqual(buf[12], 7);
      assert.strictEqual(buf.subarray(13, 20).toString(), 'example');
      assert.strictEqual(buf[20], 3);
      assert.strictEqual(buf.subarray(21, 24).toString(), 'com');
      assert.strictEqual(buf[24], 0);

      // QTYPE = A (1), QCLASS = IN (1)
      assert.strictEqual(buf.readUInt16BE(25), types.A);
      assert.strictEqual(buf.readUInt16BE(27), 1);
    });

    it('should handle domain with trailing dot', () => {
      const buf1 = buildQuery('nb', types.A, 1);
      const buf2 = buildQuery('nb.', types.A, 1);
      // Both should produce same question section
      assert.deepStrictEqual(
        buf1.subarray(12),
        buf2.subarray(12),
      );
    });

    it('should handle single-label TLD', () => {
      const buf = buildQuery('nb', types.NS, 0x0001);
      // \x02nb\x00
      assert.strictEqual(buf[12], 2);
      assert.strictEqual(buf.subarray(13, 15).toString(), 'nb');
      assert.strictEqual(buf[15], 0);
      assert.strictEqual(buf.readUInt16BE(16), types.NS);
    });
  });

  describe('parseResponse', () => {
    it('should parse an A record response', () => {
      // Hand-crafted DNS response for nb. -> A 35.81.54.236
      const buf = Buffer.from([
        0x00, 0x01,             // ID
        0x81, 0x80,             // Flags: QR=1 RD=1 RA=1
        0x00, 0x01,             // QDCOUNT
        0x00, 0x01,             // ANCOUNT
        0x00, 0x00,             // NSCOUNT
        0x00, 0x00,             // ARCOUNT
        // Question: nb.
        0x02, 0x6e, 0x62, 0x00, // \x02nb\x00
        0x00, 0x01,             // QTYPE = A
        0x00, 0x01,             // QCLASS = IN
        // Answer: nb. A 35.81.54.236 TTL=300
        0xc0, 0x0c,             // Name pointer to offset 12
        0x00, 0x01,             // TYPE = A
        0x00, 0x01,             // CLASS = IN
        0x00, 0x00, 0x01, 0x2c, // TTL = 300
        0x00, 0x04,             // RDLENGTH = 4
        0x23, 0x51, 0x36, 0xec, // 35.81.54.236
      ]);

      const res = parseResponse(buf);
      assert.strictEqual(res.id, 1);
      assert.strictEqual(res.code, 0);
      assert.strictEqual(res.answer.length, 1);
      assert.strictEqual(res.answer[0].name, 'nb.');
      assert.strictEqual(res.answer[0].type, types.A);
      assert.strictEqual(res.answer[0].ttl, 300);
      assert.strictEqual(res.answer[0].data.address, '35.81.54.236');
    });

    it('should parse NXDOMAIN response with SOA', () => {
      // Minimal NXDOMAIN response with SOA in authority
      const buf = Buffer.from([
        0x00, 0x02,             // ID
        0x81, 0x83,             // Flags: QR=1 RD=1 RA=1 RCODE=3(NXDOMAIN)
        0x00, 0x01,             // QDCOUNT
        0x00, 0x00,             // ANCOUNT
        0x00, 0x01,             // NSCOUNT
        0x00, 0x00,             // ARCOUNT
        // Question: bad.
        0x03, 0x62, 0x61, 0x64, 0x00,
        0x00, 0x01, 0x00, 0x01,
        // Authority SOA: . SOA ns. admin. serial=1
        0x00,                   // root name
        0x00, 0x06,             // TYPE = SOA
        0x00, 0x01,             // CLASS = IN
        0x00, 0x00, 0x00, 0x3c, // TTL = 60
        0x00, 0x16,             // RDLENGTH = 22
        0x02, 0x6e, 0x73, 0x00, // ns.
        0x05, 0x61, 0x64, 0x6d, 0x69, 0x6e, 0x00, // admin.
        0x00, 0x00, 0x00, 0x01, // serial = 1
        0x00, 0x00, 0x00, 0x00, // refresh (unused for test)
        0x00, 0x00,             // (padding to fill rdlength)
      ]);

      const res = parseResponse(buf);
      assert.strictEqual(res.code, 3);
      assert.strictEqual(res.answer.length, 0);
      assert.strictEqual(res.authority.length, 1);
      assert.strictEqual(res.authority[0].type, types.SOA);
      assert.strictEqual(res.authority[0].data.ns, 'ns.');
    });

    it('should parse NS records with glue', () => {
      // NS response with additional A record (glue)
      const buf = Buffer.from([
        0x00, 0x03,             // ID
        0x81, 0x80,             // Flags: QR=1 RD=1 RA=1
        0x00, 0x01,             // QDCOUNT
        0x00, 0x00,             // ANCOUNT
        0x00, 0x01,             // NSCOUNT (authority)
        0x00, 0x01,             // ARCOUNT (additional)
        // Question: test.
        0x04, 0x74, 0x65, 0x73, 0x74, 0x00,
        0x00, 0x02, 0x00, 0x01, // QTYPE=NS QCLASS=IN
        // Authority: test. NS ns1.test.
        0xc0, 0x0c,             // pointer to "test."
        0x00, 0x02,             // TYPE = NS
        0x00, 0x01,             // CLASS = IN
        0x00, 0x00, 0x0e, 0x10, // TTL = 3600
        0x00, 0x06,             // RDLENGTH
        0x03, 0x6e, 0x73, 0x31, // ns1
        0xc0, 0x0c,             // pointer to "test."
        // Additional: ns1.test. A 1.2.3.4
        0x03, 0x6e, 0x73, 0x31, // ns1
        0xc0, 0x0c,             // pointer to "test."
        0x00, 0x01,             // TYPE = A
        0x00, 0x01,             // CLASS = IN
        0x00, 0x00, 0x0e, 0x10, // TTL = 3600
        0x00, 0x04,             // RDLENGTH
        0x01, 0x02, 0x03, 0x04, // 1.2.3.4
      ]);

      const res = parseResponse(buf);
      assert.strictEqual(res.authority.length, 1);
      assert.strictEqual(res.authority[0].type, types.NS);
      assert.strictEqual(res.authority[0].data.ns, 'ns1.test.');
      assert.strictEqual(res.additional.length, 1);
      assert.strictEqual(res.additional[0].type, types.A);
      assert.strictEqual(res.additional[0].data.address, '1.2.3.4');
    });

    it('should parse TXT records', () => {
      const buf = Buffer.from([
        0x00, 0x04,             // ID
        0x81, 0x80,             // Flags
        0x00, 0x01,             // QDCOUNT
        0x00, 0x01,             // ANCOUNT
        0x00, 0x00, 0x00, 0x00,
        // Question: t.
        0x01, 0x74, 0x00,
        0x00, 0x10, 0x00, 0x01, // QTYPE=TXT
        // Answer: t. TXT "hello"
        0xc0, 0x0c,
        0x00, 0x10,             // TYPE = TXT
        0x00, 0x01,
        0x00, 0x00, 0x00, 0x3c, // TTL = 60
        0x00, 0x06,             // RDLENGTH = 6
        0x05,                   // string length 5
        0x68, 0x65, 0x6c, 0x6c, 0x6f, // "hello"
      ]);

      const res = parseResponse(buf);
      assert.strictEqual(res.answer[0].type, types.TXT);
      assert.deepStrictEqual(res.answer[0].data.txt, ['hello']);
    });
  });

  describe('utility functions', () => {
    it('rcodeName should return known codes', () => {
      assert.strictEqual(rcodeName(0), 'NOERROR');
      assert.strictEqual(rcodeName(3), 'NXDOMAIN');
      assert.strictEqual(rcodeName(5), 'REFUSED');
      assert.strictEqual(rcodeName(99), 'CODE99');
    });

    it('typeName should return known types', () => {
      assert.strictEqual(typeName(1), 'A');
      assert.strictEqual(typeName(28), 'AAAA');
      assert.strictEqual(typeName(9999), 'TYPE9999');
    });

    it('recordToString should format A record', () => {
      const rr = { type: types.A, ttl: 300, data: { address: '1.2.3.4' } };
      const s = recordToString(rr);
      assert.strictEqual(s.typeName, 'A');
      assert.strictEqual(s.data, '1.2.3.4');
      assert.strictEqual(s.ttl, 300);
    });

    it('recordToString should format NS record', () => {
      const rr = { type: types.NS, ttl: 3600, data: { ns: 'ns1.example.' } };
      const s = recordToString(rr);
      assert.strictEqual(s.typeName, 'NS');
      assert.strictEqual(s.data, 'ns1.example.');
    });

    it('recordToString should format TXT record', () => {
      const rr = { type: types.TXT, ttl: 60, data: { txt: ['hello', 'world'] } };
      const s = recordToString(rr);
      assert.strictEqual(s.data, '"hello" "world"');
    });

    it('recordToString should format SOA record', () => {
      const rr = { type: types.SOA, ttl: 60, data: { ns: 'ns.', mbox: 'admin.', serial: 42 } };
      const s = recordToString(rr);
      assert.strictEqual(s.data, 'ns. admin. (serial=42)');
    });
  });

  describe('round-trip', () => {
    it('buildQuery output should be parseable', () => {
      // buildQuery produces a query (no answers), but parseResponse should handle it
      const query = buildQuery('example.com', types.A, 0x5678);
      const res = parseResponse(query);
      assert.strictEqual(res.id, 0x5678);
      assert.strictEqual(res.code, 0);
      assert.strictEqual(res.answer.length, 0);
    });
  });
});
