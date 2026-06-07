/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SettlementCoordinator } from '../src/coordination.js';
import { SettlementWorker } from '../src/worker.js';

test('deduplicates concurrent delivery on one worker', async () => {
  let charges = 0;
  const worker = new SettlementWorker(
    'worker-a',
    async () => {
      charges += 1;
      await Promise.resolve();
      return `receipt-${charges}`;
    },
    new SettlementCoordinator(),
  );
  const event = {
    idempotencyKey: 'delivery-1042',
    accountId: 'account-7',
    amount: 2499,
  };

  const [first, second] = await Promise.all([
    worker.handle(event),
    worker.handle(event),
  ]);

  assert.equal(charges, 1);
  assert.equal(first, second);
});

test('allows a failed settlement to be retried', async () => {
  let attempts = 0;
  const worker = new SettlementWorker(
    'worker-a',
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('provider unavailable');
      }
      return 'receipt-retry';
    },
    new SettlementCoordinator(),
  );
  const event = {
    idempotencyKey: 'delivery-retry',
    accountId: 'account-7',
    amount: 2499,
  };

  await assert.rejects(worker.handle(event), /provider unavailable/);
  assert.equal(await worker.handle(event), 'receipt-retry');
});
