/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-phoenix-repair-memory-replay.ts', () => {
  it('reports a concise controlled replay contract without claiming live proof', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-memory-demo-'));
    const output = path.join(dir, 'result.json');

    const stdout = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-phoenix-repair-memory-replay.ts',
        '--controlled-runner-script',
        'scripts/testing/fake-phoenix-repair-memory-runner.mjs',
        '--workdir',
        path.join(dir, 'workdir'),
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
        },
        stdio: 'pipe',
      },
    ).toString('utf8');

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(stdout).toContain('SEED_REPAIR: PASS mode=controlled');
    expect(stdout).toContain('VERIFIED_REPAIR_RECORDED: SIMULATED');
    expect(stdout).toContain('SEED_OUTCOME_VISIBLE: SIMULATED');
    expect(stdout).toContain('REPLAY_REPAIR: PASS mode=controlled');
    expect(stdout).toContain('PHOENIX_MEMORY_MATCH: SIMULATED');
    expect(stdout).toContain('REPLAY_RETRY_TEST: PASS');
    expect(report.ok).toBe(true);
    expect(report.strictLiveProof).toBe(false);
    expect(report.seedOutcome.visible).toBe(true);
    expect(report.memory.seedSessionIds).toContain(report.seed.sessionId);
    expect(JSON.stringify(report)).not.toContain('videoSecretToken');
  }, 60000);
});
