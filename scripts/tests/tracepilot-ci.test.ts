/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-ci.mjs', () => {
  it('saves child command output to logs without streaming it by default', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-ci-'));
    const fakeNpm = path.join(dir, 'fake-npm.cjs');
    writeFileSync(
      fakeNpm,
      [
        "const command = process.argv.slice(2).join('_').replace(/[^A-Za-z0-9_]+/g, '_');",
        'console.log(`CHILD_STDOUT_${command}`);',
        'console.error(`CHILD_STDERR_${command}`);',
        'process.exit(0);',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      NO_COLOR: 'true',
      TRACEPILOT_CI_NPM_EXEC_PATH: fakeNpm,
    };
    for (const key of Object.keys(env)) {
      if (
        key.toLowerCase() === 'npm_execpath' ||
        key.toLowerCase() === 'npm_node_execpath'
      ) {
        delete env[key];
      }
    }
    delete env.PHOENIX_API_KEY;
    delete env.PHOENIX_BASE_URL;
    delete env.PHOENIX_COLLECTOR_ENDPOINT;
    delete env.PHOENIX_HOST;
    delete env.PHOENIX_PROJECT;

    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts', 'tracepilot-ci.mjs')],
      {
        cwd: dir,
        encoding: 'utf8',
        env,
        stdio: 'pipe',
        timeout: 30_000,
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain('RUN lint');
    expect(output).toContain('PASS lint');
    expect(output).toContain('PROOF_LEVEL: local_offline');
    expect(output).not.toContain('CHILD_STDOUT');
    expect(output).not.toContain('CHILD_STDERR');

    const lintLog = readFileSync(
      path.join(dir, '.ai-logs', 'tracepilot-ci', 'lint.log'),
      'utf8',
    );
    expect(lintLog).toContain('CHILD_STDOUT_run_lint');
    expect(lintLog).toContain('CHILD_STDERR_run_lint');
    const summary = JSON.parse(
      readFileSync(
        path.join(dir, '.ai-logs', 'tracepilot-ci', 'summary.json'),
        'utf8',
      ),
    );
    expect(summary).toMatchObject({
      proofLevel: 'local_offline',
      strictLiveProof: false,
    });
  }, 30000);
});
