/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const gcloudTestFiles = [
  'tracepilot-cloud-run-deploy.test.ts',
  'tracepilot-cloud-run-smoke.test.ts',
  'tracepilot-secret-manager-sync.test.ts',
];

describe('Google Cloud script test policy', () => {
  it('keeps Google Cloud deployment tests opt-in until Cloud Run is deployed', async () => {
    const { readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');

    for (const file of gcloudTestFiles) {
      const content = readFileSync(
        path.resolve('scripts', 'tests', file),
        'utf8',
      );
      expect(content).toContain('TRACEPILOT_ENABLE_GCLOUD_TESTS');
      expect(content).toContain('describeGcloud(');
    }
  });
});
