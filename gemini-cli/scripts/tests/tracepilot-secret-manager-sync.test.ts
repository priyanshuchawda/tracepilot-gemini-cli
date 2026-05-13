/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('scripts/tracepilot-secret-manager-sync.mjs', () => {
  it('dry-runs Secret Manager sync without printing secret values', () => {
    const output = execFileSync(
      process.execPath,
      [
        'scripts/tracepilot-secret-manager-sync.mjs',
        '--dry-run',
        '--project',
        'tracepilot-test-project',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GEMINI_API_KEY: 'AIzaDemoSecret000000000000000000',
          PHOENIX_API_KEY:
            'eyJdemoHeader.eyJdemoPayload.demoSignature000000000000',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    const result = JSON.parse(output);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.secrets).toEqual([
      expect.objectContaining({
        envName: 'GEMINI_API_KEY',
        secretName: 'GEMINI_API_KEY',
      }),
      expect.objectContaining({
        envName: 'PHOENIX_API_KEY',
        secretName: 'PHOENIX_API_KEY',
      }),
    ]);
    expect(output).not.toContain('AIzaDemoSecret');
    expect(output).not.toContain('eyJdemoHeader');
  });
});
