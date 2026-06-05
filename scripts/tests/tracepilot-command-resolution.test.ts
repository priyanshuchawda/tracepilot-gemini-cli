/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveTracePilotNpmCommand } from '../tracepilot-command-resolution.js';

describe('scripts/tracepilot-command-resolution.ts', () => {
  it('resolves npm through node when npm_execpath is present', () => {
    expect(
      resolveTracePilotNpmCommand(['run', 'test:tracepilot'], {
        env: {
          npm_execpath: 'C:\\node\\npm-cli.js',
        },
        fileExists: () => true,
        nodeExecutable: 'node.exe',
        platform: 'win32',
      }),
    ).toEqual({
      executable: 'node.exe',
      args: ['C:\\node\\npm-cli.js', 'run', 'test:tracepilot'],
    });
  });

  it('uses npm.cmd for bare npm commands on Windows', () => {
    expect(
      resolveTracePilotNpmCommand(['--version'], {
        env: {},
        fileExists: () => false,
        platform: 'win32',
      }),
    ).toEqual({
      executable: 'npm.cmd',
      args: ['--version'],
    });
  });

  it('prefers the bundled npm CLI next to node on Windows', () => {
    expect(
      resolveTracePilotNpmCommand(['--version'], {
        env: {},
        fileExists: (file) =>
          file ===
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32',
      }),
    ).toEqual({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        '--version',
      ],
    });
  });

  it('ignores a missing npm_execpath before applying the Windows fallback', () => {
    expect(
      resolveTracePilotNpmCommand(['--version'], {
        env: {
          npm_execpath: 'C:\\missing\\npm-cli.js',
        },
        fileExists: () => false,
        platform: 'win32',
      }),
    ).toEqual({
      executable: 'npm.cmd',
      args: ['--version'],
    });
  });

  it('keeps bare npm on non-Windows platforms', () => {
    expect(
      resolveTracePilotNpmCommand(['run', 'lint'], {
        env: {},
        fileExists: () => false,
        platform: 'linux',
      }),
    ).toEqual({
      executable: 'npm',
      args: ['run', 'lint'],
    });
  });
});
