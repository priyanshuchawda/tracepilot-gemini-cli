/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { getPaymentBaseUrl } from '../src/config.js';
import { redactDiagnostic } from '../src/redact.js';
import { verifyWebhookSignature } from '../src/signature.js';

test('uses the production payments endpoint by default', () => {
  assert.equal(getPaymentBaseUrl({}), 'https://payments.example.test');
});

test('accepts a correctly signed payment webhook', () => {
  const payload = '{"order_id":"order_1042","amount":2499}';
  const secret = 'whsec_checkout_fixture';
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  assert.equal(
    verifyWebhookSignature(payload, `sha256=${digest}`, secret),
    true,
  );
  assert.equal(verifyWebhookSignature(payload, 'sha256=bad', secret), false);
});

test('redacts bearer credentials from diagnostic output', () => {
  assert.equal(
    redactDiagnostic('Authorization: Bearer videoSecretToken'),
    'Authorization: Bearer [REDACTED]',
  );
});
