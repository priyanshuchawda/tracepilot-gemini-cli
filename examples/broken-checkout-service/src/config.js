/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Selects the payment provider endpoint for outbound checkout requests.
 */
export function getPaymentBaseUrl(env = globalThis.process?.env ?? {}) {
  return env.PAYMENTS_BASE_URL ?? 'http://localhost:8787';
}
