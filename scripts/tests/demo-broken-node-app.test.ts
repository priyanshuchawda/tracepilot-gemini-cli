/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-broken-node-app.ts', () => {
  it('runs the deterministic local repair flow without leaking secrets', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-demo-'));
    const workdir = path.join(dir, 'workdir');
    const output = path.join(dir, 'result.json');

    execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-broken-node-app.ts',
        '--allow-missing-phoenix',
        '--workdir',
        workdir,
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    );

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.localRepairOk).toBe(true);
    expect(report.phoenix.visible).toBe(false);
    expect(report.eval.ok).toBe(false);
    expect(report.eval.results).toHaveLength(7);
    expect(JSON.stringify(report)).not.toContain('sk-proj-demoSecret');
  }, 30000);
});
