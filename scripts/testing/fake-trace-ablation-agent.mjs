#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.argv[2];
if (!workspace) {
  throw new Error('Expected a benchmark workspace.');
}
const delayMs = Number.parseInt(
  process.env['TRACEPILOT_FAKE_AGENT_DELAY_MS'] ?? '0',
  10,
);

try {
  await access(path.join(workspace, '.tracepilot', 'production-trace.json'));
} catch {
  await progress(delayMs, [
    'scan repository tests',
    'inspect idempotency worker state',
    'attempt code-only repair hypothesis',
  ]);
  console.log(JSON.stringify({ status: 'no_change', evidence: false }));
  process.exit(0);
}

await progress(delayMs, [
  'load Arize production trace',
  'match session memory to incident',
  'locate cross-worker reservation boundary',
  'patch worker to delegate idempotency atomically',
]);
await writeFile(
  path.join(workspace, 'src', 'worker.js'),
  `/**
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
  }

  async handle(event) {
    const key = event.idempotencyKey;
    const fingerprint = JSON.stringify([event.accountId, event.amount]);
    this.emit({
      worker: this.name,
      operation: 'coordinator.reserve',
      key,
    });
    return this.coordinator.execute(key, fingerprint, () =>
      this.charge(event),
    );
  }
}
`,
  'utf8',
);
console.log(JSON.stringify({ status: 'repaired', evidence: true }));

async function progress(totalMs, steps) {
  const interval = Math.max(0, Math.floor(totalMs / Math.max(1, steps.length)));
  for (const step of steps) {
    if (interval > 0) {
      await delay(interval);
    }
    console.log(JSON.stringify({ status: 'progress', step }));
  }
}

function delay(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, milliseconds)),
  );
}
