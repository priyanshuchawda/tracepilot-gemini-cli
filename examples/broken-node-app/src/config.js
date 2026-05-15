/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Intentional demo bug: the default URL should point at the public API.
 */
export function getApiBaseUrl(env = globalThis.process?.env ?? {}) {
  return env.API_BASE_URL ?? 'http://localhost:3000';
}
