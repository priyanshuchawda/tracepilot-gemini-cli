/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type TracePilotVerificationKind =
  | 'failed_command'
  | 'typecheck'
  | 'lint'
  | 'build'
  | 'tests'
  | 'dependency_integrity'
  | 'regression_scope'
  | 'patch_minimality';

export interface TracePilotVerificationCheck {
  id: TracePilotVerificationKind;
  command?: string;
  required: boolean;
  reason: string;
}

export interface TracePilotVerificationResult
  extends TracePilotVerificationCheck {
  status: 'pass' | 'fail' | 'skipped';
  exitCode?: number;
  outputSha256?: string;
}

export interface TracePilotVerificationMatrixInput {
  failedCommand?: string;
  filesModified: string[];
  packageFilesModified?: boolean;
  sharedModulesModified?: boolean;
}

export function buildTracePilotVerificationMatrix(
  input: TracePilotVerificationMatrixInput,
): TracePilotVerificationCheck[] {
  const checks: TracePilotVerificationCheck[] = [];
  if (input.failedCommand) {
    checks.push({
      id: 'failed_command',
      command: input.failedCommand,
      required: true,
      reason: 'prove the originally observed failure is repaired',
    });
  }
  checks.push(
    {
      id: 'typecheck',
      command: 'npm run typecheck',
      required: true,
      reason: 'verify TypeScript stability across workspaces',
    },
    {
      id: 'lint',
      command: 'npm run lint',
      required: true,
      reason: 'verify static analysis stability',
    },
    {
      id: 'build',
      command: 'npm run build',
      required: true,
      reason: 'verify package build integrity',
    },
    {
      id: 'tests',
      command: input.sharedModulesModified
        ? 'npm test'
        : 'npm run test:tracepilot',
      required: true,
      reason: input.sharedModulesModified
        ? 'shared module changed; run full test suite'
        : 'run focused TracePilot regression suite',
    },
  );
  if (input.packageFilesModified) {
    checks.push({
      id: 'dependency_integrity',
      command: 'npm run check:lockfile',
      required: true,
      reason: 'package metadata changed; verify lockfile consistency',
    });
  }
  checks.push(
    {
      id: 'regression_scope',
      required: true,
      reason: 'confirm verification covered affected and unrelated surfaces',
    },
    {
      id: 'patch_minimality',
      required: true,
      reason: 'confirm repair changed only files needed for the root cause',
    },
  );
  return checks;
}

export function calculateTracePilotRegressionConfidence(
  results: TracePilotVerificationResult[],
): number {
  const required = results.filter((result) => result.required);
  if (required.length === 0) {
    return 0;
  }
  const passed = required.filter((result) => result.status === 'pass').length;
  const failed = required.filter((result) => result.status === 'fail').length;
  const skipped = required.filter(
    (result) => result.status === 'skipped',
  ).length;
  return clamp((passed - failed * 1.5 - skipped * 0.5) / required.length);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
