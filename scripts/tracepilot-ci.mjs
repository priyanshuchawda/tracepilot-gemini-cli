#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(
  new URL('./tracepilot-ci.ts', import.meta.url),
);
const tsxLoaderUrl = pathToFileURL(require.resolve('tsx')).href;
const child = spawn(
  process.execPath,
  ['--import', tsxLoaderUrl, scriptPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on('close', (exitCode) => {
  process.exitCode = exitCode ?? 1;
});
