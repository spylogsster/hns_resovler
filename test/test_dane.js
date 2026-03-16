/* Copyright (c) 2026 Sergei P <spylogsster@gmail.com>
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  extractCertData,
  computeMatch,
  formatDANEResult,
  USAGE_NAMES,
  SELECTOR_NAMES,
  MATCHING_NAMES,
} = require('../lib/dane');

describe('dane', () => {
  describe('computeMatch', () => {
    it('should return hex for exact match (type 0)', () => {
      const data = Buffer.from('hello');
      const result = computeMatch(data, 0);
      assert.strictEqual(result, data.toString('hex'));
    });

    it('should compute SHA-256 (type 1)', () => {
      const data = Buffer.from('test data for hashing');
      const expected = crypto.createHash('sha256').update(data).digest('hex');
      const result = computeMatch(data, 1);
      assert.strictEqual(result, expected);
    });

    it('should compute SHA-512 (type 2)', () => {
      const data = Buffer.from('test data for hashing');
      const expected = crypto.createHash('sha512').update(data).digest('hex');
      const result = computeMatch(data, 2);
      assert.strictEqual(result, expected);
    });
  });

  describe('extractCertData', () => {
    it('should return full cert for selector 0', () => {
      const fakeCert = Buffer.alloc(100);
      fakeCert.fill(0xAA);
      const result = extractCertData(fakeCert, 0);
      assert.deepStrictEqual(result, fakeCert);
    });

    it('should return full cert for unknown selector', () => {
      const fakeCert = Buffer.alloc(50);
      fakeCert.fill(0xBB);
      const result = extractCertData(fakeCert, 99);
      assert.deepStrictEqual(result, fakeCert);
    });
  });

  describe('formatDANEResult', () => {
    it('should format verified result', () => {
      const result = {
        verified: true,
        usage: 3,
        selector: 1,
        matchingType: 1,
        usageName: 'DANE-EE',
        selectorName: 'SubjectPublicKeyInfo',
        matchingName: 'SHA-256',
      };
      const formatted = formatDANEResult(result);
      assert.ok(formatted.includes('VERIFIED'));
      assert.ok(formatted.includes('SHA-256'));
      assert.ok(formatted.includes('DANE-EE'));
    });

    it('should format failed result', () => {
      const result = {
        verified: false,
        error: 'Certificate does not match any TLSA record',
      };
      const formatted = formatDANEResult(result);
      assert.ok(formatted.includes('FAILED'));
      assert.ok(formatted.includes('does not match'));
    });

    it('should format connection error result', () => {
      const result = {
        verified: false,
        error: 'TLS connection failed: ECONNREFUSED',
      };
      const formatted = formatDANEResult(result);
      assert.ok(formatted.includes('FAILED'));
      assert.ok(formatted.includes('ECONNREFUSED'));
    });
  });

  describe('constants', () => {
    it('should have correct USAGE_NAMES', () => {
      assert.strictEqual(USAGE_NAMES[0], 'PKIX-TA');
      assert.strictEqual(USAGE_NAMES[1], 'PKIX-EE');
      assert.strictEqual(USAGE_NAMES[2], 'DANE-TA');
      assert.strictEqual(USAGE_NAMES[3], 'DANE-EE');
    });

    it('should have correct SELECTOR_NAMES', () => {
      assert.strictEqual(SELECTOR_NAMES[0], 'Full certificate');
      assert.strictEqual(SELECTOR_NAMES[1], 'SubjectPublicKeyInfo');
    });

    it('should have correct MATCHING_NAMES', () => {
      assert.strictEqual(MATCHING_NAMES[0], 'Exact');
      assert.strictEqual(MATCHING_NAMES[1], 'SHA-256');
      assert.strictEqual(MATCHING_NAMES[2], 'SHA-512');
    });
  });
});
