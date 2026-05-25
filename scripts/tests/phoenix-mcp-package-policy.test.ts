/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const phoenixMcpLaunchers = [
  'packages/core/src/telemetry/phoenixSelfIntrospection.ts',
  'scripts/phoenix-mcp-smoke.mjs',
  'scripts/demo-broken-node-app.ts',
  'scripts/demo-gemini-repair-agent.ts',
  'scripts/demo-phoenix-repair-memory-replay.ts',
];
const phoenixMcpUtility = 'packages/core/src/telemetry/phoenixMcpUtils.ts';
const defaultPackageSpec = '@arizeai/phoenix-mcp@4.0.13';
const floatingPackageSpec = ['@arizeai/phoenix-mcp', 'latest'].join('@');

describe('Phoenix MCP package policy', () => {
  it('uses a pinned default package spec instead of @latest', async () => {
    const { readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');

    for (const file of [phoenixMcpUtility, ...phoenixMcpLaunchers]) {
      const content = readFileSync(path.resolve(file), 'utf8');

      expect(content, file).not.toContain(floatingPackageSpec);
    }
    expect(readFileSync(path.resolve(phoenixMcpUtility), 'utf8')).toContain(
      defaultPackageSpec,
    );
  });

  it('routes launchers through the shared Phoenix MCP utility', async () => {
    const { readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');

    for (const file of phoenixMcpLaunchers) {
      const content = readFileSync(path.resolve(file), 'utf8');
      expect(content, file).toMatch(
        /phoenixMcpUtils|resolveDirectPhoenixMcpConfig/,
      );
    }
  });
});
