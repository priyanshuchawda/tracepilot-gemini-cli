/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const dependabotPath = path.resolve('.github', 'dependabot.yml');

describe('Dependabot policy', () => {
  it('keeps version-update PR creation disabled for noisy ecosystems', async () => {
    const { readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const config = readFileSync(dependabotPath, 'utf8');

    expect(getUpdateBlock(config, "'npm'")).toContain(
      'open-pull-requests-limit: 0',
    );
    expect(getUpdateBlock(config, "'github-actions'")).toContain(
      'open-pull-requests-limit: 0',
    );
  });
});

function getUpdateBlock(config: string, packageEcosystem: string): string {
  const marker = `  - package-ecosystem: ${packageEcosystem}`;
  const start = config.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing Dependabot ecosystem: ${packageEcosystem}`);
  }

  const rest = config.slice(start + marker.length);
  const nextUpdateIndex = rest.search(/\n {2}- package-ecosystem: /);
  return nextUpdateIndex === -1
    ? config.slice(start)
    : config.slice(start, start + marker.length + nextUpdateIndex);
}
