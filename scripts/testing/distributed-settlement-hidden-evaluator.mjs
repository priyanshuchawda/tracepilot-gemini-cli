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
  throw new Error('Expected a benchmark workspace.');
}

const { SettlementCoordinator } = await import(
  pathToFileURL(path.join(workspace, 'src', 'coordination.js')).href
);
const { SettlementWorker } = await import(
  pathToFileURL(path.join(workspace, 'src', 'worker.js')).href
);
const checks = [];

await check('cross_worker_atomicity', async () => {
  let charges = 0;
  const coordinator = new SettlementCoordinator();
  const charge = async () => {
    charges += 1;
    await Promise.resolve();
    return `receipt-${charges}`;
  };
  const workerA = new SettlementWorker('worker-a', charge, coordinator);
  const workerB = new SettlementWorker('worker-b', charge, coordinator);
  const event = eventFor('delivery-shared');
  const [first, second] = await Promise.all([
    workerA.handle(event),
    workerB.handle(event),
  ]);
  assert(charges === 1 && first === second, `charges=${charges}`);
});

await check('failed_reservation_released', async () => {
  let attempts = 0;
  const coordinator = new SettlementCoordinator();
  const charge = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('provider unavailable');
    return 'receipt-recovered';
  };
  const workerA = new SettlementWorker('worker-a', charge, coordinator);
  const workerB = new SettlementWorker('worker-b', charge, coordinator);
  await Promise.allSettled([
    workerA.handle(eventFor('delivery-retry')),
    workerB.handle(eventFor('delivery-retry')),
  ]);
  const receipt = await workerA.handle(eventFor('delivery-retry'));
  assert(receipt === 'receipt-recovered', `receipt=${receipt}`);
});

await check('payload_conflict_rejected', async () => {
  const coordinator = new SettlementCoordinator();
  const charge = async (event) => {
    await Promise.resolve();
    return `receipt-${event.amount}`;
  };
  const workerA = new SettlementWorker('worker-a', charge, coordinator);
  const workerB = new SettlementWorker('worker-b', charge, coordinator);
  const first = workerA.handle(eventFor('delivery-conflict', 2499));
  const second = workerB.handle(eventFor('delivery-conflict', 4999));
  const results = await Promise.allSettled([first, second]);
  assert(
    results.some(
      (result) =>
        result.status === 'rejected' &&
        /payload conflict/i.test(String(result.reason)),
    ),
    'conflict was not rejected',
  );
});

const passed = checks.filter((item) => item.status === 'pass').length;
console.log(
  JSON.stringify({
    ok: passed === checks.length,
    score: passed / checks.length,
    passed,
    total: checks.length,
    checks,
  }),
);
process.exitCode = passed === checks.length ? 0 : 1;

async function check(id, operation) {
  try {
    await operation();
    checks.push({ id, status: 'pass' });
  } catch (error) {
    checks.push({
      id,
      status: 'fail',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function eventFor(idempotencyKey, amount = 2499) {
  return { idempotencyKey, accountId: 'account-7', amount };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
