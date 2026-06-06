/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryLedger } from '../src/ledger.js';

test('preserves the settlement invariant during duplicate delivery', async () => {
  let settlements = 0;
  const ledger = new DeliveryLedger(async () => {
    settlements += 1;
    await Promise.resolve();
    return `receipt-${settlements}`;
  });
  const event = {
    idempotencyKey: 'delivery-1042',
    amount: 2499,
  };

  await Promise.all([ledger.handle(event), ledger.handle(event)]);

  assert.equal(settlements, 1, 'settlement invariant violated');
});
