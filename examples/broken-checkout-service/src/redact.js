/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Removes credential-looking text before diagnostic records are retained.
 */
export function redactDiagnostic(value) {
  return value.replace(
    /PAYMENTS_API_KEY=[^\s]+/g,
    'PAYMENTS_API_KEY=[REDACTED]',
  );
}
