/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-check-folder.ts', () => {
  it('writes a shared-builder repair artifact for a passing folder check', async () => {
    const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-check-folder-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        devDependencies: {
          typescript: '^5.0.0',
          vitest: '^3.0.0',
        },
      }),
    );
    writeExecutableScript(
      path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'),
      'console.log("tsc pass");',
      { mkdirSync, writeFileSync },
    );
    writeExecutableScript(
      path.join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      'console.log("eslint pass");',
      { mkdirSync, writeFileSync },
    );
    writeExecutableScript(
      path.join(dir, 'node_modules', 'vitest', 'vitest.mjs'),
      'console.log("vitest pass");',
      { mkdirSync, writeFileSync },
    );

    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-check-folder.ts',
        '--workdir',
        dir,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    ).toString('utf8');

    const artifactPath = path.join(
      dir,
      '.ai-logs',
      'tracepilot-check',
      'repair-artifact.json',
    );
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(stdout).toContain(`TracePilot repair artifact: ${artifactPath}`);
    expect(artifact).toMatchObject({
      phase: 'verified',
      failure: {
        summary: 'Verification matrix passed without repair.',
        signature: {
          dependencies: {
            typescript: '^5.0.0',
            vitest: '^3.0.0',
          },
        },
      },
      completion: {
        attempts: 1,
        finalExitCode: 0,
        verificationPassed: true,
      },
      repair: {
        filesModified: [],
        patches: [],
      },
    });
    expect(artifact.completion.retryCommands).toHaveLength(4);
    expect(artifact.phoenix.mcpQueries[0].arguments.signatureId).toBe(
      artifact.failure.signature.id,
    );
    expect(artifact.verification.matrix).toHaveLength(4);
  }, 30000);
});

function writeExecutableScript(
  file: string,
  body: string,
  fs: {
    mkdirSync: typeof import('node:fs').mkdirSync;
    writeFileSync: typeof import('node:fs').writeFileSync;
  },
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}
