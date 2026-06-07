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

const { EnterpriseBillingService } = await import(
  pathToFileURL(path.join(workspace, 'src', 'billing.js')).href
);
const { SharedLedger } = await import(
  pathToFileURL(path.join(workspace, 'src', 'shared-ledger.js')).href
);
const checks = [];

await check('cross_region_atomic_idempotency', async () => {
  let charges = 0;
  const provider = {
    async charge(event) {
      charges += 1;
      await Promise.resolve();
      return { id: `receipt-${charges}`, accountId: event.accountId };
    },
  };
  const ledger = new SharedLedger();
  const riskEngine = allowRisk();
  const east = new EnterpriseBillingService(
    'us-east-1',
    ledger,
    provider,
    riskEngine,
  );
  const west = new EnterpriseBillingService(
    'eu-west-1',
    ledger,
    provider,
    riskEngine,
  );
  const [first, second] = await Promise.all([
    east.handleWebhook(eventFor('retry-shared')),
    west.handleWebhook(eventFor('retry-shared')),
  ]);
  assert(charges === 1 && first.id === second.id, `charges=${charges}`);
});

await check('failed_provider_reservation_released', async () => {
  let attempts = 0;
  const provider = {
    async charge(event) {
      attempts += 1;
      if (attempts === 1) throw new Error('processor timeout');
      return { id: 'receipt-recovered', accountId: event.accountId };
    },
  };
  const service = new EnterpriseBillingService(
    'us-east-1',
    new SharedLedger(),
    provider,
    allowRisk(),
  );
  await Promise.allSettled([
    service.handleWebhook(eventFor('retry-after-failure')),
    service.handleWebhook(eventFor('retry-after-failure')),
  ]);
  const receipt = await service.handleWebhook(eventFor('retry-after-failure'));
  assert(receipt.id === 'receipt-recovered', `receipt=${receipt.id}`);
});

await check('payload_conflict_rejected', async () => {
  const provider = {
    async charge(event) {
      return { id: `receipt-${event.amount}`, accountId: event.accountId };
    },
  };
  const ledger = new SharedLedger();
  const east = new EnterpriseBillingService(
    'us-east-1',
    ledger,
    provider,
    allowRisk(),
  );
  const west = new EnterpriseBillingService(
    'eu-west-1',
    ledger,
    provider,
    allowRisk(),
  );
  const results = await Promise.allSettled([
    east.handleWebhook(eventFor('conflict-key', 4200)),
    west.handleWebhook(eventFor('conflict-key', 9900)),
  ]);
  assert(
    results.some(
      (result) =>
        result.status === 'rejected' &&
        /payload conflict/i.test(String(result.reason)),
    ),
    'conflict was not rejected',
  );
});

await check('risk_cache_is_payload_scoped', async () => {
  const riskEngine = {
    async score(event) {
      return { decision: event.amount > 5000 ? 'reject' : 'allow' };
    },
  };
  const service = new EnterpriseBillingService(
    'us-east-1',
    new SharedLedger(),
    {
      async charge(event) {
        return { id: `receipt-${event.amount}`, accountId: event.accountId };
      },
    },
    riskEngine,
  );
  await service.handleWebhook(eventFor('low-risk', 4200));
  await assertRejects(
    () => service.handleWebhook(eventFor('high-risk', 9900)),
    /risk rejected/i,
  );
});

await check('telemetry_redacts_pii', async () => {
  const emitted = [];
  const service = new EnterpriseBillingService(
    'us-east-1',
    new SharedLedger(),
    {
      async charge(event) {
        return { id: `receipt-${event.amount}`, accountId: event.accountId };
      },
    },
    allowRisk(),
    (event) => emitted.push(event),
  );
  await service.handleWebhook(eventFor('telemetry'));
  const serialized = JSON.stringify(emitted);
  assert(!serialized.includes('@'), serialized);
  assert(!serialized.includes('4242'), serialized);
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

function allowRisk() {
  return {
    async score() {
      return { decision: 'allow' };
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(operation, pattern) {
  try {
    await operation();
  } catch (error) {
    assert(pattern.test(String(error)), String(error));
    return;
  }
  throw new Error('expected rejection');
}
