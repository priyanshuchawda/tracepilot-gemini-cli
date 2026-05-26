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
    expect(output).toContain('TracePilot CI tier: fast');
    expect(output).toContain('RUN tracepilot-tests');
    expect(output).toContain('PASS tracepilot-tests');
    expect(output).toContain('SKIP lint: requires medium tier');
    expect(output).toContain('PROOF_LEVEL: local_offline');
    expect(output).not.toContain('CHILD_STDOUT');
    expect(output).not.toContain('CHILD_STDERR');

    const tracepilotLog = readFileSync(
      path.join(dir, '.ai-logs', 'tracepilot-ci', 'tracepilot-tests.log'),
      'utf8',
    );
    expect(tracepilotLog).toContain('CHILD_STDOUT_run_test_tracepilot');
    expect(tracepilotLog).toContain('CHILD_STDERR_run_test_tracepilot');
    const summary = JSON.parse(
      readFileSync(
        path.join(dir, '.ai-logs', 'tracepilot-ci', 'summary.json'),
        'utf8',
      ),
    );
    expect(summary).toMatchObject({
      tier: 'fast',
      proofLevel: 'local_offline',
      strictLiveProof: false,
      gates: {
        required: [
          {
            name: 'tracepilot-tests',
            status: 'passed',
            tier: 'fast',
            required: true,
          },
        ],
      },
    });
    expect(
      summary.gates.skipped.map((item: { name: string }) => item.name),
    ).toContain('lint');
  }, 30000);

  it('runs medium tier when requested and records required, optional, and skipped gates', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-ci-medium-'));
    const fakeNpm = path.join(dir, 'fake-npm.cjs');
    writeFileSync(fakeNpm, 'console.log(process.argv.slice(2).join(" "));');
    const env = {
      ...process.env,
      NO_COLOR: 'true',
      TRACEPILOT_CI_NPM_EXEC_PATH: fakeNpm,
    };
    delete env.PHOENIX_API_KEY;
    delete env.PHOENIX_BASE_URL;
    delete env.PHOENIX_COLLECTOR_ENDPOINT;
    delete env.PHOENIX_HOST;
    delete env.PHOENIX_PROJECT;

    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts', 'tracepilot-ci.mjs'), '--tier=medium'],
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
    expect(output).toContain('TracePilot CI tier: medium');
    expect(output).toContain('RUN lint');
    expect(output).toContain('RUN broken-node-demo-offline');
    expect(output).toContain('SKIP root-tests: requires full tier');

    const summary = JSON.parse(
      readFileSync(
        path.join(dir, '.ai-logs', 'tracepilot-ci', 'summary.json'),
        'utf8',
      ),
    );
    expect(summary.tier).toBe('medium');
    expect(
      summary.gates.required.map((item: { name: string }) => item.name),
    ).toEqual([
      'tracepilot-tests',
      'lint',
      'typecheck',
      'build',
      'broken-node-demo-offline',
    ]);
    expect(summary.gates.optional).toEqual([]);
    expect(
      summary.gates.skipped.map((item: { name: string }) => item.name),
    ).toEqual(
      expect.arrayContaining([
        'phoenix-otel-smoke',
        'phoenix-mcp-smoke',
        'root-tests',
        'cloud-run-local-smoke',
      ]),
    );
  }, 30000);
});
