/* Copyright (c) 2026 Sergei P <spylogsster@gmail.com>
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  findBinary,
  writePidFile,
  readPidFile,
  removePidFile,
  DATA_DIR,
  PID_FILE,
} = require('../lib/hnsd_manager');

describe('hnsd_manager', () => {
  describe('findBinary', () => {
    it('should throw when explicit path does not exist', () => {
      assert.throws(
        () => findBinary('/nonexistent/hnsd'),
        /not found at/,
      );
    });

    it('should accept explicit path when file exists', () => {
      // Use node binary as a stand-in for testing path resolution
      const nodePath = process.execPath;
      const result = findBinary(nodePath);
      assert.strictEqual(result, nodePath);
    });

    it('should search bin/ directory', () => {
      // This test verifies the search logic without requiring hnsd to be built
      try {
        findBinary();
        // If found, that's fine
      } catch (e) {
        assert.match(e.message, /hnsd binary not found/);
        assert.match(e.message, /build_hnsd/);
      }
    });
  });

  describe('PID file management', () => {
    const testDir = path.join(os.tmpdir(), 'hnsd-test-pid-' + process.pid);
    const origPidFile = PID_FILE;

    it('should write and read PID file', () => {
      fs.mkdirSync(DATA_DIR, { recursive: true });

      writePidFile(12345, 15350);
      const info = readPidFile();

      assert.ok(info);
      assert.strictEqual(info.pid, 12345);
      assert.strictEqual(info.port, 15350);
      assert.ok(info.ts > 0);

      removePidFile();
    });

    it('should return null when PID file does not exist', () => {
      removePidFile();
      const info = readPidFile();
      assert.strictEqual(info, null);
    });

    it('should not throw when removing non-existent PID file', () => {
      removePidFile(); // should not throw
      removePidFile(); // double remove should not throw
    });
  });
});
