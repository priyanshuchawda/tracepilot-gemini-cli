#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.argv[2];
if (!workspace) {
  throw new Error('Expected the copied benchmark workspace path.');
}

await writeFile(
  path.join(workspace, 'src', 'ledger.js'),
  `/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class DeliveryLedger {
  constructor(charge, emit = () => {}) {
    this.charge = charge;
    this.emit = emit;
    this.processed = new Map();
    this.inFlight = new Map();
  }

  async handle(event) {
    const key = event.idempotencyKey;
    const prior = this.processed.get(key);
    if (prior) {
      this.emit({ operation: 'idempotency.check', key, outcome: 'hit' });
      return { status: 'duplicate', receipt: prior };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.emit({ operation: 'idempotency.join', key });
      return { status: 'duplicate', receipt: await pending };
    }

    this.emit({ operation: 'idempotency.reserve', key });
    const settlement = this.charge(event);
    this.inFlight.set(key, settlement);
    try {
      const receipt = await settlement;
      this.processed.set(key, receipt);
      this.emit({ operation: 'idempotency.commit', key, receipt });
      return { status: 'processed', receipt };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
`,
  'utf8',
);

console.log(JSON.stringify({ type: 'result', status: 'success' }));
