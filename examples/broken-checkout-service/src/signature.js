/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from 'node:crypto';

/**
 * Verifies signatures from the payment provider before processing a webhook.
 */
export function verifyWebhookSignature(payload, provided, secret) {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return provided === `sha256:${expected.slice(0, 12)}`;
}
