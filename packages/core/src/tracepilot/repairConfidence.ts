/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TracePilotRepairCandidate } from './repairMemory.js';
import type { TracePilotPatchRiskLevel } from './repairRisk.js';

export interface TracePilotConfidenceInput {
  topCandidate?: TracePilotRepairCandidate;
  phoenixEvidenceAvailable: boolean;
  verificationCoverageScore: number;
  patchMinimalityScore: number;
  riskLevel: TracePilotPatchRiskLevel;
  regressionPassed: boolean;
}

export interface TracePilotConfidenceScore {
  score: number;
  cappedBy: string[];
  components: {
    similarity: number;
    historicalOutcome: number;
    verificationCoverage: number;
    patchMinimality: number;
    risk: number;
  };
}

export function calculateTracePilotRepairConfidence(
  input: TracePilotConfidenceInput,
): TracePilotConfidenceScore {
  const components = {
    similarity: input.topCandidate?.similarityScore ?? 0,
    historicalOutcome: input.topCandidate?.historicalOutcomeScore ?? 0,
    verificationCoverage: clamp(input.verificationCoverageScore),
    patchMinimality: clamp(input.patchMinimalityScore),
    risk: riskScore(input.riskLevel),
  };
  const cappedBy: string[] = [];
  let score =
    components.similarity * 0.35 +
    components.historicalOutcome * 0.25 +
    components.verificationCoverage * 0.15 +
    components.patchMinimality * 0.15 +
    components.risk * 0.1;

  if (!input.phoenixEvidenceAvailable) {
    score = Math.min(score, 0.62);
    cappedBy.push('missing_phoenix_evidence');
  }
  if (!input.regressionPassed) {
    score = Math.min(score, 0.58);
    cappedBy.push('regression_not_verified');
  }
  if (input.riskLevel === 'HIGH') {
    score = Math.min(score, 0.72);
    cappedBy.push('high_risk_patch');
  }
  if (input.riskLevel === 'BLOCKED') {
    score = 0;
    cappedBy.push('blocked_patch');
  }

  return {
    score: clamp(score),
    cappedBy,
    components,
  };
}

function riskScore(level: TracePilotPatchRiskLevel): number {
  switch (level) {
    case 'LOW':
      return 1;
    case 'MEDIUM':
      return 0.72;
    case 'HIGH':
      return 0.35;
    case 'BLOCKED':
      return 0;
    default:
      return 0;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
