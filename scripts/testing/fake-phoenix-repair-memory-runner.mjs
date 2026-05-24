#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const options = parseArgs(process.argv.slice(2));
const sessionId =
  options.phase === 'seed'
    ? 'controlled-seed-session'
    : 'controlled-replay-session';
const report = {
  ok: true,
  sessionId,
  agent: { mode: 'controlled', exitCode: 0 },
  repair: {
    verifiedOutcomeRecorded: options.phase === 'seed',
    changedFiles: ['src/config.js', 'src/redact.js', 'src/signature.js'],
  },
  retryTest: { exitCode: 0 },
  eval: { ok: true },
  memory:
    options.phase === 'replay'
      ? { seedSessionIds: [options.seedSessionId] }
      : undefined,
};

await mkdir(path.dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

function parseArgs(argv) {
  const result = {
    phase: 'seed',
    output: '',
    seedSessionId: '',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--phase') result.phase = argv[++index] ?? result.phase;
    if (arg === '--output') result.output = argv[++index] ?? result.output;
    if (arg === '--seed-session-id') {
      result.seedSessionId = argv[++index] ?? result.seedSessionId;
    }
  }
  if (!result.output) {
    throw new Error('Missing --output');
  }
  return result;
}
