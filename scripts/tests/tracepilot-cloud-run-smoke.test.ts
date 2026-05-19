/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const describeGcloud =
  process.env.TRACEPILOT_ENABLE_GCLOUD_TESTS === 'true'
    ? describe
    : describe.skip;

describeGcloud('scripts/tracepilot-cloud-run-smoke.mjs', () => {
  it('verifies the local Cloud Run surface without leaking secrets', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/tracepilot-cloud-run-smoke.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GEMINI_API_KEY: 'AIzaDemoSecret000000000000000000',
          PHOENIX_API_KEY: 'px-demo-secret-0000000000000000',
          PHOENIX_HOST: 'https://app.phoenix.arize.com/s/demo',
          PHOENIX_PROJECT: 'tracepilot-test',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    const result = JSON.parse(output);
    expect(result.ok).toBe(true);
    expect(result.geminiConfigured).toBe(true);
    expect(result.phoenixConfigured).toBe(true);
    expect(output).not.toContain('AIzaDemoSecret');
    expect(output).not.toContain('px-demo-secret');
  });
});
