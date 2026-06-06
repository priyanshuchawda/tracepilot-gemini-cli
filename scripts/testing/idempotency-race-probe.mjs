#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
if (!workspace) {
  throw new Error('Expected the benchmark workspace path.');
}

const { DeliveryLedger } = await import(
  pathToFileURL(path.join(workspace, 'src', 'ledger.js')).href
);
const trace = [];
let settlements = 0;
const ledger = new DeliveryLedger(
  async () => {
    settlements += 1;
    trace.push({
      operation: 'settlement.start',
      key: 'delivery-1042',
      attempt: settlements,
    });
    await Promise.resolve();
    return `receipt-${settlements}`;
  },
  (event) => trace.push(event),
);
const event = { idempotencyKey: 'delivery-1042', amount: 2499 };
await Promise.all([ledger.handle(event), ledger.handle(event)]);

const missesBeforeCommit = trace
  .slice(
    0,
    trace.findIndex((entry) => entry.operation === 'idempotency.commit'),
  )
  .filter(
    (entry) =>
      entry.operation === 'idempotency.check' && entry.outcome === 'miss',
  ).length;

console.log(
  JSON.stringify({
    invariant: 'at_most_one_settlement_per_idempotency_key',
    observedSettlements: settlements,
    missesBeforeFirstCommit: missesBeforeCommit,
    rootCause:
      settlements > 1 && missesBeforeCommit > 1
        ? 'non_atomic_check_then_commit'
        : 'invariant_preserved',
    trace,
  }),
);
