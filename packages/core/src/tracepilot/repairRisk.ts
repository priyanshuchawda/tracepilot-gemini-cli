/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type TracePilotPatchRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';

export interface TracePilotPatchRiskInput {
  filesModified: string[];
  dependencyChanges?: number;
  linesAdded?: number;
  linesDeleted?: number;
  touchesDeployment?: boolean;
  touchesPolicyOrAuth?: boolean;
  destructiveCommandBlocked?: boolean;
}

export interface TracePilotPatchRiskAssessment {
  level: TracePilotPatchRiskLevel;
  reasons: string[];
  requiresApproval: boolean;
  rollbackRequired: boolean;
}

export function classifyTracePilotPatchRisk(
  input: TracePilotPatchRiskInput,
): TracePilotPatchRiskAssessment {
  const files = [
    ...new Set(input.filesModified.map((file) => file.toLowerCase())),
  ];
  const totalLineDelta = (input.linesAdded ?? 0) + (input.linesDeleted ?? 0);
  const reasons: string[] = [];

  if (input.destructiveCommandBlocked) {
    return {
      level: 'BLOCKED',
      reasons: ['destructive command was blocked before repair orchestration'],
      requiresApproval: true,
      rollbackRequired: true,
    };
  }

  if (input.touchesDeployment || files.some(isDeploymentFile)) {
    reasons.push('patch touches deployment or release configuration');
  }
  if (input.touchesPolicyOrAuth || files.some(isPolicyOrAuthFile)) {
    reasons.push('patch touches policy, authorization, or credential handling');
  }
  if (files.length > 8 || totalLineDelta > 300) {
    reasons.push('patch has broad file or line-count blast radius');
  }
  if (reasons.length > 0) {
    return {
      level: 'HIGH',
      reasons,
      requiresApproval: true,
      rollbackRequired: true,
    };
  }

  if (files.length > 1 || totalLineDelta > 80) {
    return {
      level: 'MEDIUM',
      reasons: ['scoped multi-file or moderate-size patch'],
      requiresApproval: false,
      rollbackRequired: true,
    };
  }

  if ((input.dependencyChanges ?? 0) > 0 || files.some(isConfigFile)) {
    return {
      level: 'LOW',
      reasons: ['dependency pinning or configuration-only repair'],
      requiresApproval: false,
      rollbackRequired: false,
    };
  }

  return {
    level: 'LOW',
    reasons: ['single-file minimal repair'],
    requiresApproval: false,
    rollbackRequired: false,
  };
}

function isDeploymentFile(file: string): boolean {
  return /(?:dockerfile|cloudbuild|deploy|release|wrangler|vercel|netlify|helm|k8s|kubernetes)/.test(
    file,
  );
}

function isPolicyOrAuthFile(file: string): boolean {
  return /(?:policy|auth|oauth|credential|secret|permission|security)/.test(
    file,
  );
}

function isConfigFile(file: string): boolean {
  return /(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig|eslint|prettier|config)/.test(
    file,
  );
}
