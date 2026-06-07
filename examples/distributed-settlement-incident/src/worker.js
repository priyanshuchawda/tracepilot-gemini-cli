/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class SettlementWorker {
  constructor(name, charge, coordinator, emit = () => {}) {
    this.name = name;
    this.charge = charge;
    this.coordinator = coordinator;
    this.emit = emit;
    this.completed = new Map();
    this.inFlight = new Map();
  }

  async handle(event) {
    const key = event.idempotencyKey;
    const prior = this.completed.get(key);
    this.emit({
      worker: this.name,
      operation: 'worker.idempotency_check',
      key,
      outcome: prior ? 'hit' : 'miss',
    });
    if (prior) {
      return prior;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const settlement = this.charge(event);
    this.inFlight.set(key, settlement);
    try {
      const receipt = await settlement;
      this.completed.set(key, receipt);
      return receipt;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
