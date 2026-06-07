/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class EnterpriseBillingService {
  constructor(region, ledger, provider, riskEngine, emit = () => {}) {
    this.region = region;
    this.ledger = ledger;
    this.provider = provider;
    this.riskEngine = riskEngine;
    this.emit = emit;
    this.completed = new Map();
    this.inFlight = new Map();
    this.riskCache = new Map();
  }

  async handleWebhook(event) {
    const risk = await this.lookupRisk(event);
    if (risk.decision === 'reject') {
      throw new Error('risk rejected payment');
    }

    const key = event.idempotencyKey;
    const cached = this.completed.get(key);
    if (cached) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    this.emit({
      type: 'billing_attempt',
      region: this.region,
      idempotencyKey: key,
      customerEmail: event.customerEmail,
      cardLast4: event.cardLast4,
    });

    const charge = this.provider.charge(event).then((receipt) => {
      this.ledger.record(receipt);
      this.completed.set(key, receipt);
      return receipt;
    });
    this.inFlight.set(key, charge);
    try {
      return await charge;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async lookupRisk(event) {
    const cacheKey = event.accountId;
    const cached = this.riskCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const decision = await this.riskEngine.score(event);
    this.riskCache.set(cacheKey, decision);
    return decision;
  }
}
