/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-comparison.ts', () => {
  it('runs simultaneous fair arms in persistent test1 and test2 folders', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const directory = mkdtempSync(path.join(tmpdir(), 'comparison-test-'));
    const workdir = path.join(directory, 'workspaces');
    const output = path.join(directory, 'result.json');
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-comparison.ts',
        '--workdir',
        workdir,
        '--output',
        output,
        '--agent-script',
        'scripts/testing/fake-trace-ablation-agent.mjs',
        '--budget-ms',
        '10000',
        '--memory-file',
        path.join(directory, 'memory.json'),
      ],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
    );
    const report = JSON.parse(readFileSync(output, 'utf8'));

    expect(stdout).toContain('COMPARISON_EVENT:');
    expect(report).toMatchObject({
      ok: true,
      winner: 'tracepilot',
      outcome: 'tracepilot_advantage',
      fairness: {
        samePrompt: true,
        sameStartingWorkspace: true,
        sameModel: true,
        samePermissions: true,
        sameDeadline: true,
        sameEvaluator: true,
        hiddenEvaluatorVisibleToAgents: false,
      },
      arms: [
        {
          arm: 'blind',
          workspace: path.join(workdir, 'test1'),
          evidenceAccess: false,
          sessionMemoryEntries: 0,
          hiddenAfter: { passed: 1, total: 3 },
          metrics: { bugHits: 1, bugMisses: 2 },
          solved: false,
        },
        {
          arm: 'tracepilot',
          workspace: path.join(workdir, 'test2'),
          evidenceAccess: true,
          sessionMemoryEntries: expect.any(Number),
          hiddenAfter: { passed: 3, total: 3 },
          metrics: { bugHits: 3, bugMisses: 0 },
          solved: true,
        },
      ],
    });
    expect(report.arms[0].workspaceDigestBefore).toBe(
      report.arms[1].workspaceDigestBefore,
    );
    expect(
      JSON.parse(readFileSync(path.join(directory, 'memory.json'), 'utf8'))
        .entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observedOutcome:
            'verified repair passed all external production checks',
        }),
      ]),
    );
    expect(
      readFileSync(path.join(workdir, 'test1', 'src', 'worker.js')),
    ).not.toEqual(
      readFileSync(path.join(workdir, 'test2', 'src', 'worker.js')),
    );
  }, 30000);
});
