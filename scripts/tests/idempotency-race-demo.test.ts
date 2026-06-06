/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-idempotency-race-repair.ts', () => {
  it('uses causal trace evidence and survives repeated verification', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const directory = mkdtempSync(path.join(tmpdir(), 'tracepilot-race-'));
    const workspace = path.join(directory, 'workspace');
    const output = path.join(directory, 'result.json');
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/demo-idempotency-race-repair.ts',
        '--workdir',
        workspace,
        '--output',
        output,
        '--stress-runs',
        '8',
        '--agent-script',
        'scripts/testing/fake-idempotency-repair-agent.mjs',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    const report = JSON.parse(readFileSync(output, 'utf8'));

    expect(stdout).toContain('TRACE_EVIDENCE: non_atomic_check_then_commit');
    expect(stdout).toContain('STRESS_VERIFICATION: PASS runs=8');
    expect(report).toMatchObject({
      ok: true,
      proofLevel: 'controlled_trace_assisted',
      competitorClaimsMeasured: false,
      traceEvidence: {
        rootCause: 'non_atomic_check_then_commit',
        observedSettlements: 2,
        missesBeforeFirstCommit: 2,
      },
      repair: {
        changedFiles: ['src/ledger.js'],
        onlyExpectedFilesChanged: true,
      },
      stressVerification: {
        runs: 8,
        failures: 0,
      },
      repairedTrace: {
        observedSettlements: 1,
        rootCause: 'invariant_preserved',
      },
    });
  }, 30000);
});
