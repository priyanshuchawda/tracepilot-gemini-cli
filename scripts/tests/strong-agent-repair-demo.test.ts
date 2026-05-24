/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-gemini-repair-agent.ts', () => {
  it('reports a concise local agent proof without leaking secrets', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-strong-demo-'));
    const workdir = path.join(dir, 'workdir');
    const output = path.join(dir, 'result.json');

    const stdout = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-gemini-repair-agent.ts',
        '--allow-missing-phoenix',
        '--agent-script',
        'scripts/testing/fake-checkout-repair-agent.mjs',
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
    ).toString('utf8');

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(stdout).toContain('AGENT_REPAIR: PASS');
    expect(stdout).toContain('PHOENIX_MCP_INTROSPECTION: DEGRADED');
    expect(stdout).toContain('VERIFIED_REPAIR_RECORDED: DEGRADED');
    expect(stdout).toContain('FILES_CHANGED: PASS count=3');
    expect(stdout).toContain('RETRY_TEST: PASS');
    expect(stdout).toContain(`REPORT: ${output}`);
    expect(report.ok).toBe(true);
    expect(report.agent.mode).toBe('substitute');
    expect(report.repair.changedFiles).toHaveLength(3);
    expect(report.repair.verifiedOutcomeRecorded).toBe(false);
    expect(report.eval.results).toHaveLength(7);
    expect(JSON.stringify(report)).not.toContain('videoSecretToken');
  }, 180000);
});
