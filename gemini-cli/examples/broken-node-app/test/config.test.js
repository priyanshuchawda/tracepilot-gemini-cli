/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiBaseUrl } from '../src/config.js';

test('uses the production API base URL when API_BASE_URL is not set', () => {
  assert.equal(getApiBaseUrl({}), 'https://api.example.test');
});
