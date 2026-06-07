/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseBillingService } from '../src/billing.js';
import { SharedLedger } from '../src/shared-ledger.js';

test('charges a normal billing webhook', async () => {
  const ledger = new SharedLedger();
  const provider = {
    async charge(event) {
      return { id: `receipt-${event.amount}`, accountId: event.accountId };
    },
  };
  const riskEngine = {
    async score() {
      return { decision: 'allow' };
    },
  };
  const service = new EnterpriseBillingService(
    'us-east-1',
    ledger,
    provider,
    riskEngine,
  );

  const receipt = await service.handleWebhook(eventFor('invoice-1'));

  assert.equal(receipt.id, 'receipt-4200');
});

function eventFor(idempotencyKey, amount = 4200) {
  return {
    idempotencyKey,
    accountId: 'acct-enterprise-7',
    invoiceId: 'invoice-7',
    amount,
    currency: 'USD',
    customerEmail: 'cto@example.com',
    cardLast4: '4242',
  };
}
