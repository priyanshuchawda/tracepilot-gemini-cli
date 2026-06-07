/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class SharedLedger {
  constructor() {
    this.entries = new Map();
  }

  async reserve(key, fingerprint, operation) {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('idempotency payload conflict');
      }
      return existing.promise;
    }

    const promise = Promise.resolve().then(operation);
    this.entries.set(key, { fingerprint, promise });
    try {
      return await promise;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  record(receipt) {
    this.entries.set(`receipt:${receipt.id}`, {
      fingerprint: receipt.accountId,
      promise: Promise.resolve(receipt),
    });
  }
}
