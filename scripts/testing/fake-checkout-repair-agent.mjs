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
  throw new Error('Expected the copied demo workspace path.');
}

await writeFile(
  path.join(workspace, 'src', 'config.js'),
  `/**
 * Selects the payment provider endpoint for outbound checkout requests.
 */
export function getPaymentBaseUrl(env = globalThis.process?.env ?? {}) {
  return env.PAYMENTS_BASE_URL ?? 'https://payments.example.test';
}
`,
  'utf8',
);

await writeFile(
  path.join(workspace, 'src', 'signature.js'),
  `import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies signatures from the payment provider before processing a webhook.
 */
export function verifyWebhookSignature(payload, provided, secret) {
  const expected = \`sha256=\${createHmac('sha256', secret).update(payload).digest('hex')}\`;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
`,
  'utf8',
);

await writeFile(
  path.join(workspace, 'src', 'redact.js'),
  `/**
 * Removes credential-looking text before diagnostic records are retained.
 */
export function redactDiagnostic(value) {
  return value
    .replace(/PAYMENTS_API_KEY=[^\\s]+/g, 'PAYMENTS_API_KEY=[REDACTED]')
    .replace(/(Authorization:\\s*Bearer\\s+)[^\\s]+/gi, '$1[REDACTED]');
}
`,
  'utf8',
);

console.log(
  JSON.stringify({ type: 'result', status: 'success', mode: 'substitute' }),
);
