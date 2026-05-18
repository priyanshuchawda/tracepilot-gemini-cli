/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const workflowPath = path.resolve('.github', 'workflows', 'tracepilot-ci.yml');

describe('TracePilot CI workflow', () => {
  it('keeps diagnostic artifact upload from failing passing gates', async () => {
    const { readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const workflow = readFileSync(workflowPath, 'utf8');
    const uploadStep = getStepBlock(
      workflow,
      "      - name: 'Upload TracePilot logs'",
    );

    expect(uploadStep).toContain("        if: '${{ always() }}'");
    expect(uploadStep).toContain('        continue-on-error: true');
    expect(uploadStep).toContain("          path: '.ai-logs/tracepilot-ci'");
    expect(uploadStep).toContain("          if-no-files-found: 'ignore'");
    expect(uploadStep).toContain('          retention-days: 3');
  });
});

function getStepBlock(workflow: string, stepName: string): string {
  const start = workflow.indexOf(stepName);
  if (start === -1) {
    throw new Error(`Missing workflow step: ${stepName.trim()}`);
  }

  const rest = workflow.slice(start + stepName.length);
  const nextStepIndex = rest.search(/\n {6}- name: /);
  return nextStepIndex === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + stepName.length + nextStepIndex);
}
