/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-doctor.ts', () => {
  it('reports deterministic readiness without leaking missing live env secrets', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-doctor-'));
    const output = path.join(dir, 'doctor.json');

    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-doctor.ts',
        '--json',
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          GEMINI_API_KEY: '',
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
          PHOENIX_PROJECT: '',
        },
        stdio: 'pipe',
      },
    );

    const report = JSON.parse(stdout);
    const written = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.localDeterministicReady).toBe(true);
    expect(report.strictLiveReady).toBe(false);
    expect(report.phoenix.mcpReady).toBe(false);
    expect(report.gemini.apiKeyPresent).toBe(false);
    expect(written).toMatchObject({
      localDeterministicReady: report.localDeterministicReady,
      strictLiveReady: false,
    });
  }, 30000);

  it('reports strict live readiness from env presence without printing secret values', () => {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/tracepilot-doctor.ts', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          GEMINI_API_KEY: 'AIzaDemoSecret000000000000000000',
          PHOENIX_API_KEY: 'px-demo-secret-0000000000000000',
          PHOENIX_HOST: 'https://app.phoenix.arize.com/s/demo',
          PHOENIX_BASE_URL: 'https://app.phoenix.arize.com/s/demo',
          PHOENIX_COLLECTOR_ENDPOINT:
            'https://app.phoenix.arize.com/s/demo/v1/traces',
          PHOENIX_PROJECT: 'tracepilot-test',
        },
        stdio: 'pipe',
      },
    );

    const report = JSON.parse(stdout);
    expect(report.strictLiveReady).toBe(true);
    expect(report.phoenix).toMatchObject({
      collectorReady: true,
      mcpReady: true,
      normalizedHostPresent: true,
      projectPresent: true,
    });
    expect(stdout).not.toContain('AIzaDemoSecret');
    expect(stdout).not.toContain('px-demo-secret');
  }, 30000);
});
