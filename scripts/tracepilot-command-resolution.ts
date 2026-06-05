/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export interface TracePilotResolvedCommand {
  executable: string;
  args: string[];
}

export function resolveTracePilotNpmCommand(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    nodeExecutable?: string;
    fileExists?: (file: string) => boolean;
  } = {},
): TracePilotResolvedCommand {
  const env = options.env ?? process.env;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const fileExists = options.fileExists ?? existsSync;
  const npmExecPath = env['TRACEPILOT_CI_NPM_EXEC_PATH'] || env['npm_execpath'];
  if (npmExecPath && fileExists(npmExecPath)) {
    return {
      executable: nodeExecutable,
      args: [npmExecPath, ...args],
    };
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const bundledNpmCli = path.win32.join(
      path.win32.dirname(nodeExecutable),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    if (fileExists(bundledNpmCli)) {
      return {
        executable: nodeExecutable,
        args: [bundledNpmCli, ...args],
      };
    }
    return {
      executable: 'npm.cmd',
      args,
    };
  }
  return {
    executable: 'npm',
    args,
  };
}
