/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-evals.ts', () => {
  it('writes sanitized machine-readable JSON eval results', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-evals-'));
    const input = path.join(dir, 'evidence.json');
    const output = path.join(dir, 'result.json');
    writeFileSync(
      input,
      JSON.stringify({
        command: {
          command: 'npm test',
          completed: true,
          exitCode: 0,
          outputPreview: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
          outputSha256: 'a'.repeat(64),
        },
        test: { command: 'npm test', passed: true, exitCode: 0 },
        safety: { command: 'rm -rf /', blocked: true },
        redaction: {
          samples: [
            {
              input: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
              output: 'OPENAI_API_KEY=[REDACTED]',
            },
          ],
        },
        phoenix: {
          spanCreated: true,
          exported: true,
          visible: true,
          queryable: true,
        },
        selfIntrospection: {
          triggered: true,
          queryAttempted: true,
          evidenceAttached: true,
        },
        repair: {
          planCreated: true,
          referencedTraceEvidence: true,
          fixApplied: true,
          retryExitCode: 0,
          evalLogged: true,
        },
      }),
    );

    execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/tracepilot-evals.ts',
        '--input',
        input,
        '--output',
        output,
      ],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(7);
    expect(JSON.stringify(report)).not.toContain('sk-proj-secret');
  });
});
