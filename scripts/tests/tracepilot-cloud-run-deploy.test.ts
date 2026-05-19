/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('scripts/tracepilot-cloud-run-deploy.mjs', () => {
  it('dry-runs secret bindings and Phoenix env without leaking values', () => {
    const output = execFileSync(
      process.execPath,
      [
        'scripts/tracepilot-cloud-run-deploy.mjs',
        '--dry-run',
        '--project',
        'tracepilot-test-project',
        '--region',
        'asia-south1',
        '--service',
        'tracepilot-test-service',
        '--phoenix-host',
        'https://app.phoenix.arize.com/s/demo-space',
        '--phoenix-base-url',
        'https://app.phoenix.arize.com/s/demo-space',
        '--phoenix-collector-endpoint',
        'https://app.phoenix.arize.com/s/demo-space',
        '--set-env',
        'TRACEPILOT_INTERNAL_TOKEN=custom-secret-value-12345',
        '--secret',
        'GEMINI_API_KEY=GEMINI_API_KEY',
        '--secret',
        'PHOENIX_API_KEY=PHOENIX_API_KEY',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    const result = JSON.parse(output);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.secretsConfigured).toEqual([
      'GEMINI_API_KEY',
      'PHOENIX_API_KEY',
    ]);
    expect(result.envConfigured).toEqual(
      expect.arrayContaining([
        'PHOENIX_PROJECT',
        'PHOENIX_HOST',
        'PHOENIX_BASE_URL',
        'PHOENIX_COLLECTOR_ENDPOINT',
      ]),
    );
    expect(output).not.toContain('demo-space');
    expect(output).not.toContain('custom-secret-value-12345');

    const envArgIndex = result.deployArgs.indexOf('--set-env-vars');
    expect(envArgIndex).toBeGreaterThanOrEqual(0);
    const envArg = result.deployArgs[envArgIndex + 1];
    expect(envArg).toContain('PHOENIX_HOST=[VALUE]');
    expect(envArg).toContain('TRACEPILOT_INTERNAL_TOKEN=[VALUE]');
  });
});
