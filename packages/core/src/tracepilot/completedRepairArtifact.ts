/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRedactedOutputPreview } from '../telemetry/sanitize.js';
import {
  buildTracePilotFailureSignature,
  type TracePilotFailureSignature,
} from './failureSignature.js';
import {
  calculateTracePilotRepairConfidence,
  type TracePilotConfidenceInput,
} from './repairConfidence.js';
import {
  completeTracePilotRepairArtifact,
  createTracePilotRepairArtifact,
  type TracePilotMcpQueryRecord,
  type TracePilotPatchSummary,
  type TracePilotRepairArtifact,
} from './repairReport.js';
import { classifyTracePilotPatchRisk } from './repairRisk.js';
import type { TracePilotVerificationResult } from './verificationMatrix.js';

export interface TracePilotCommandOutcome {
  command: string;
  exitCode: number;
  output: string;
}

export interface BuildCompletedTracePilotRepairArtifactInput {
  sessionId: string;
  failedCommand: TracePilotCommandOutcome;
  retryCommand: TracePilotCommandOutcome;
  filesModified: string[];
  patches: TracePilotPatchSummary[];
  selectedStrategy: string[];
  rollbackStrategy: string[];
  verificationMatrix: TracePilotVerificationResult[];
  phoenixEvidenceAvailable: boolean;
  phoenixTracesConsulted: string[];
  phoenixMcpQueries:
    | TracePilotMcpQueryRecord[]
    | ((signature: TracePilotFailureSignature) => TracePilotMcpQueryRecord[]);
  repairDurationMs?: number;
  completedAt?: string;
  failureSummary?: string;
  failureSignatureDependencies?: Record<string, string>;
  completion?: {
    attempts?: number;
    retryCommands?: string[];
    finalExitCode?: number;
  };
  confidence?: Partial<
    Pick<
      TracePilotConfidenceInput,
      'verificationCoverageScore' | 'patchMinimalityScore' | 'regressionPassed'
    >
  >;
}

export function buildCompletedTracePilotRepairArtifact(
  input: BuildCompletedTracePilotRepairArtifactInput,
): TracePilotRepairArtifact {
  const failedPreview = createRedactedOutputPreview(input.failedCommand.output);
  const signature = buildTracePilotFailureSignature({
    command: input.failedCommand.command,
    exitCode: input.failedCommand.exitCode,
    outputPreview: failedPreview.preview,
    outputSha256: failedPreview.sha256,
    dependencies: input.failureSignatureDependencies,
  });
  const patchRisk = classifyTracePilotPatchRisk({
    filesModified: input.filesModified,
    linesAdded: input.patches.reduce((sum, patch) => sum + patch.linesAdded, 0),
    linesDeleted: input.patches.reduce(
      (sum, patch) => sum + patch.linesDeleted,
      0,
    ),
  });
  const verificationPassed = input.verificationMatrix.every(
    (check) => !check.required || check.status === 'pass',
  );
  const phoenixMcpQueries =
    typeof input.phoenixMcpQueries === 'function'
      ? input.phoenixMcpQueries(signature)
      : input.phoenixMcpQueries;
  const plannedArtifact = createTracePilotRepairArtifact({
    schemaVersion: 1,
    sessionId: input.sessionId,
    phase: 'planned',
    failure: {
      summary:
        input.failureSummary ??
        `Command failed in ${input.failedCommand.command}`,
      rootCause: signature.taxonomy,
      signature,
    },
    phoenix: {
      tracesConsulted: input.phoenixTracesConsulted,
      mcpQueries: phoenixMcpQueries,
    },
    repair: {
      selectedStrategy: input.selectedStrategy,
      historicalMatches: [],
      patches: [],
      filesModified: [],
    },
    safety: {
      risk: patchRisk,
      rollbackStrategy: input.rollbackStrategy,
    },
    verification: {
      matrix: [],
      regressionConfidence: 0,
    },
    confidence: calculateTracePilotRepairConfidence({
      phoenixEvidenceAvailable: input.phoenixEvidenceAvailable,
      verificationCoverageScore:
        input.confidence?.verificationCoverageScore ??
        (verificationPassed ? 1 : 0.4),
      patchMinimalityScore: input.confidence?.patchMinimalityScore ?? 1,
      riskLevel: patchRisk.level,
      regressionPassed:
        input.confidence?.regressionPassed ?? verificationPassed,
    }),
    metrics: {
      repairDurationMs: input.repairDurationMs ?? 0,
      retriesRequired: 0,
      unsafeCommandsBlocked: 0,
    },
  });

  return completeTracePilotRepairArtifact(plannedArtifact, {
    filesModified: input.filesModified,
    patches: input.patches,
    verificationMatrix: input.verificationMatrix,
    retryMetadata: {
      attempts: input.completion?.attempts ?? 1,
      retryCommands: input.completion?.retryCommands ?? [
        input.retryCommand.command,
      ],
      finalExitCode:
        input.completion?.finalExitCode ?? input.retryCommand.exitCode,
    },
    repairDurationMs: input.repairDurationMs,
    completedAt: input.completedAt,
    rollbackStrategy: input.rollbackStrategy,
  });
}
