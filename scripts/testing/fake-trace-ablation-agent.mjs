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

try {
  await access(path.join(workspace, '.tracepilot', 'production-trace.json'));
} catch {
  console.log(JSON.stringify({ status: 'no_change', evidence: false }));
  process.exit(0);
}

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
