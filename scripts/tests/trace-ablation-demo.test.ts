/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-trace-ablation.ts', () => {
  it('compares byte-identical blind and trace-assisted workspaces', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const directory = mkdtempSync(path.join(tmpdir(), 'trace-ablation-test-'));
    const output = path.join(directory, 'result.json');
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/demo-trace-ablation.ts',
        '--output',
        output,
        '--agent-script',
        'scripts/testing/fake-trace-ablation-agent.mjs',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    const report = JSON.parse(readFileSync(output, 'utf8'));

    expect(stdout).toContain('ABLATION_OUTCOME: trace_assistance_advantage');
    expect(report).toMatchObject({
      ok: true,
      samePrompt: true,
      sameStartingWorkspace: true,
      hiddenEvaluatorVisibleToAgent: false,
      competitorClaimsMeasured: false,
      outcome: 'trace_assistance_advantage',
      arms: [
        {
          arm: 'blind',
          evidenceAccess: false,
          publicTestsPassedBefore: true,
          hiddenBefore: { score: 1 / 3 },
          hiddenAfter: { score: 1 / 3 },
          solved: false,
        },
        {
          arm: 'trace_assisted',
          evidenceAccess: true,
          publicTestsPassedBefore: true,
          hiddenBefore: { score: 1 / 3 },
          hiddenAfter: { score: 1 },
          changedFiles: ['src/worker.js'],
          solved: true,
        },
      ],
    });
    expect(report.arms[0].workspaceDigestBefore).toBe(
      report.arms[1].workspaceDigestBefore,
    );
  }, 30000);
});
