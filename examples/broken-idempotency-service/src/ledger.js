/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class DeliveryLedger {
  constructor(charge, emit = () => {}) {
    this.charge = charge;
    this.emit = emit;
    this.processed = new Map();
  }

  async handle(event) {
    const prior = this.processed.get(event.idempotencyKey);
    this.emit({
      operation: 'idempotency.check',
      key: event.idempotencyKey,
      outcome: prior ? 'hit' : 'miss',
    });
    if (prior) {
      return { status: 'duplicate', receipt: prior };
    }

    const receipt = await this.charge(event);
    this.processed.set(event.idempotencyKey, receipt);
    this.emit({
      operation: 'idempotency.commit',
      key: event.idempotencyKey,
      receipt,
    });
    return { status: 'processed', receipt };
  }
}
