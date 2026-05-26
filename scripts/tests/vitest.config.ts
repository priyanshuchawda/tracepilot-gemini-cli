/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@google\/gemini-cli-core$/,
        replacement: path.join(repoRoot, 'packages/core/index.ts'),
      },
      {
        find: /^@google\/gemini-cli-core\/(.*)$/,
        replacement: path.join(repoRoot, 'packages/core/$1'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/tests/**/*.test.{js,ts}'],
    setupFiles: ['scripts/tests/test-setup.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
      },
    },
  },
});
