/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class SettlementCoordinator {
  constructor() {
    this.entries = new Map();
  }

  async execute(key, fingerprint, operation) {
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
}
