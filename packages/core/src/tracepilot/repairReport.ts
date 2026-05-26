/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stableStringify } from '../policy/stable-stringify.js';
import { redactSensitiveText } from '../telemetry/sanitize.js';
import { z } from 'zod';
import type { TracePilotFailureSignature } from './failureSignature.js';
import type { TracePilotConfidenceScore } from './repairConfidence.js';
import type { TracePilotPatchRiskAssessment } from './repairRisk.js';
import {
  assertNoSecretLikeValues,
  parseTracePilotSchema,
  unknownRecordSchema,
} from './runtimeValidation.js';
import {
  calculateTracePilotRegressionConfidence,
  type TracePilotVerificationResult,
} from './verificationMatrix.js';

export type TracePilotRepairPhase =
  | 'planned'
  | 'applied'
  | 'verified'
  | 'failed';

export interface TracePilotMcpQueryRecord {
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resultCount: number;
  status: 'ok' | 'error' | 'skipped';
  reason?: string;
}

export interface TracePilotPatchSummary {
  file: string;
  linesAdded: number;
  linesDeleted: number;
  description: string;
}

export interface TracePilotRepairArtifact {
  schemaVersion: 1;
  sessionId: string;
  phase: TracePilotRepairPhase;
  failure: {
    summary: string;
    rootCause: string;
    signature: TracePilotFailureSignature;
  };
  phoenix: {
    tracesConsulted: string[];
    mcpQueries: TracePilotMcpQueryRecord[];
  };
  repair: {
    selectedStrategy: string[];
    historicalMatches: Array<{
      sessionId: string;
      traceId?: string;
      similarityScore: number;
      historicalOutcomeScore: number;
      matchedReasons: string[];
    }>;
    patches: TracePilotPatchSummary[];
    filesModified: string[];
  };
  safety: {
    risk: TracePilotPatchRiskAssessment;
    rollbackStrategy: string[];
  };
  verification: {
    matrix: TracePilotVerificationResult[];
    regressionConfidence: number;
  };
  confidence: TracePilotConfidenceScore;
  metrics: {
    repairDurationMs: number;
    retriesRequired: number;
    unsafeCommandsBlocked: number;
  };
  completion?: TracePilotRepairCompletion;
}

export interface TracePilotRepairCompletion {
  completedAt?: string;
  attempts: number;
  retryCommands: string[];
  finalExitCode?: number;
  verificationPassed: boolean;
}

export interface TracePilotCompletedRepairUpdate {
  filesModified: string[];
  patches: TracePilotPatchSummary[];
  verificationMatrix: TracePilotVerificationResult[];
  retryMetadata: {
    attempts: number;
    retryCommands: string[];
    finalExitCode?: number;
  };
  repairDurationMs?: number;
  completedAt?: string;
  rollbackStrategy?: string[];
}

export function createTracePilotRepairArtifact(
  artifact: TracePilotRepairArtifact,
): TracePilotRepairArtifact {
  validateTracePilotRepairArtifactShape(artifact);
  return validateTracePilotRepairArtifact(sanitizeArtifact(artifact));
}

export function completeTracePilotRepairArtifact(
  artifact: TracePilotRepairArtifact,
  update: TracePilotCompletedRepairUpdate,
): TracePilotRepairArtifact {
  const validatedArtifact = validateTracePilotRepairArtifact(artifact);
  const validatedUpdate = validateTracePilotCompletedRepairUpdate(update);
  const verificationPassed = validatedUpdate.verificationMatrix.every(
    (check) => !check.required || check.status === 'pass',
  );
  const phase: TracePilotRepairPhase = verificationPassed
    ? 'verified'
    : update.verificationMatrix.some((check) => check.status === 'fail')
      ? 'failed'
      : 'applied';
  return sanitizeArtifact({
    ...validatedArtifact,
    phase,
    repair: {
      ...validatedArtifact.repair,
      patches: validatedUpdate.patches,
      filesModified: validatedUpdate.filesModified,
    },
    safety: {
      ...validatedArtifact.safety,
      rollbackStrategy:
        validatedUpdate.rollbackStrategy ??
        validatedArtifact.safety.rollbackStrategy,
    },
    verification: {
      matrix: validatedUpdate.verificationMatrix,
      regressionConfidence: calculateTracePilotRegressionConfidence(
        validatedUpdate.verificationMatrix,
      ),
    },
    metrics: {
      ...validatedArtifact.metrics,
      repairDurationMs:
        validatedUpdate.repairDurationMs ??
        validatedArtifact.metrics.repairDurationMs,
      retriesRequired: Math.max(0, validatedUpdate.retryMetadata.attempts - 1),
    },
    completion: {
      completedAt: validatedUpdate.completedAt,
      attempts: validatedUpdate.retryMetadata.attempts,
      retryCommands: validatedUpdate.retryMetadata.retryCommands,
      finalExitCode: validatedUpdate.retryMetadata.finalExitCode,
      verificationPassed,
    },
  });
}

export function renderTracePilotRepairMarkdown(
  artifact: TracePilotRepairArtifact,
): string {
  const sanitized = sanitizeArtifact(artifact);
  const lines = [
    '# TracePilot Repair Report',
    '',
    `Session: ${sanitized.sessionId}`,
    `Phase: ${sanitized.phase}`,
    `Failure signature: ${sanitized.failure.signature.id}`,
    `Root cause: ${sanitized.failure.rootCause}`,
    `Confidence: ${Math.round(sanitized.confidence.score * 100)}%`,
    `Risk: ${sanitized.safety.risk.level}`,
    `Regression confidence: ${Math.round(
      sanitized.verification.regressionConfidence * 100,
    )}%`,
    '',
    '## Evidence',
    `Summary: ${sanitized.failure.summary}`,
    `Phoenix traces consulted: ${sanitized.phoenix.tracesConsulted.join(', ') || 'none'}`,
    `MCP queries: ${sanitized.phoenix.mcpQueries.length}`,
    '',
    '## Historical Matches',
    ...sanitized.repair.historicalMatches.map(
      (match) =>
        `- ${match.sessionId}: similarity=${formatScore(
          match.similarityScore,
        )}, outcome=${formatScore(match.historicalOutcomeScore)}, reasons=${match.matchedReasons.join(
          ', ',
        )}`,
    ),
    '',
    '## Selected Strategy',
    ...sanitized.repair.selectedStrategy.map((step) => `- ${step}`),
    '',
    '## Patches',
    `Files modified: ${sanitized.repair.filesModified.join(', ') || 'none'}`,
    ...sanitized.repair.patches.map(
      (patch) =>
        `- ${patch.file}: +${patch.linesAdded}/-${patch.linesDeleted} ${patch.description}`,
    ),
    sanitized.repair.patches.length === 0 ? '- none' : '',
    '',
    '## Verification Matrix',
    ...sanitized.verification.matrix.map(
      (check) =>
        `- ${check.id}: ${check.status}${check.command ? ` (${check.command})` : ''}`,
    ),
    '',
    '## Completion',
    sanitized.completion
      ? `Attempts: ${sanitized.completion.attempts}; verification_passed=${sanitized.completion.verificationPassed}; final_exit_code=${sanitized.completion.finalExitCode ?? 'unknown'}`
      : 'Not completed yet.',
    ...(sanitized.completion?.retryCommands.map(
      (command) => `- retry: ${command}`,
    ) ?? []),
    '',
    '## Safety',
    ...sanitized.safety.risk.reasons.map((reason) => `- ${reason}`),
    '',
    '## Rollback Strategy',
    ...sanitized.safety.rollbackStrategy.map((step) => `- ${step}`),
    '',
  ];
  return `${lines.join('\n')}`;
}

export function stableTracePilotRepairArtifactJson(
  artifact: TracePilotRepairArtifact,
): string {
  return `${stableStringify(validateTracePilotRepairArtifact(sanitizeArtifact(artifact))).replace(/\0/g, '')}\n`;
}

const verificationResultSchema = z
  .object({
    id: z.enum([
      'failed_command',
      'typecheck',
      'lint',
      'build',
      'tests',
      'dependency_integrity',
      'regression_scope',
      'patch_minimality',
    ]),
    command: z.string().optional(),
    required: z.boolean(),
    reason: z.string(),
    status: z.enum(['pass', 'fail', 'skipped']),
    exitCode: z.number().int().optional(),
    outputSha256: z.string().optional(),
  })
  .strict();

const patchSummarySchema = z
  .object({
    file: z.string(),
    linesAdded: z.number().int().nonnegative(),
    linesDeleted: z.number().int().nonnegative(),
    description: z.string(),
  })
  .strict();

const repairCompletionSchema = z
  .object({
    completedAt: z.string().optional(),
    attempts: z.number().int().positive(),
    retryCommands: z.array(z.string()),
    finalExitCode: z.number().int().optional(),
    verificationPassed: z.boolean(),
  })
  .strict();

const repairArtifactSchema: z.ZodType<TracePilotRepairArtifact> = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string(),
    phase: z.enum(['planned', 'applied', 'verified', 'failed']),
    failure: z
      .object({
        summary: z.string(),
        rootCause: z.string(),
        signature: z
          .object({
            id: z.string(),
            taxonomy: z.enum([
              'typescript_incompatibility',
              'lint_failure',
              'test_assertion_failure',
              'build_failure',
              'dependency_graph_failure',
              'runtime_exception',
              'unknown',
            ]),
            commandFamily: z.string(),
            exitCode: z.number().int().optional(),
            diagnostics: z.array(z.string()),
            stackFrames: z.array(z.string()),
            files: z.array(z.string()),
            dependencies: z.record(z.string()),
            outputSha256: z.string().optional(),
            canonical: unknownRecordSchema,
          })
          .strict(),
      })
      .strict(),
    phoenix: z
      .object({
        tracesConsulted: z.array(z.string()),
        mcpQueries: z.array(
          z
            .object({
              serverName: z.string(),
              toolName: z.string(),
              arguments: unknownRecordSchema,
              resultCount: z.number().int().nonnegative(),
              status: z.enum(['ok', 'error', 'skipped']),
              reason: z.string().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    repair: z
      .object({
        selectedStrategy: z.array(z.string()),
        historicalMatches: z.array(
          z
            .object({
              sessionId: z.string(),
              traceId: z.string().optional(),
              similarityScore: z.number().min(0).max(1),
              historicalOutcomeScore: z.number().min(0).max(1),
              matchedReasons: z.array(z.string()),
            })
            .strict(),
        ),
        patches: z.array(patchSummarySchema),
        filesModified: z.array(z.string()),
      })
      .strict(),
    safety: z
      .object({
        risk: z
          .object({
            level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'BLOCKED']),
            reasons: z.array(z.string()),
            requiresApproval: z.boolean(),
            rollbackRequired: z.boolean(),
          })
          .strict(),
        rollbackStrategy: z.array(z.string()),
      })
      .strict(),
    verification: z
      .object({
        matrix: z.array(verificationResultSchema),
        regressionConfidence: z.number().min(0).max(1),
      })
      .strict(),
    confidence: z
      .object({
        score: z.number().min(0).max(1),
        cappedBy: z.array(z.string()),
        components: z
          .object({
            similarity: z.number().min(0).max(1),
            historicalOutcome: z.number().min(0).max(1),
            verificationCoverage: z.number().min(0).max(1),
            patchMinimality: z.number().min(0).max(1),
            risk: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict(),
    metrics: z
      .object({
        repairDurationMs: z.number().nonnegative(),
        retriesRequired: z.number().int().nonnegative(),
        unsafeCommandsBlocked: z.number().int().nonnegative(),
      })
      .strict(),
    completion: repairCompletionSchema.optional(),
  })
  .strict();

const completionUpdateSchema: z.ZodType<TracePilotCompletedRepairUpdate> = z
  .object({
    filesModified: z.array(z.string()),
    patches: z.array(patchSummarySchema),
    verificationMatrix: z.array(verificationResultSchema),
    retryMetadata: z
      .object({
        attempts: z.number().int().positive(),
        retryCommands: z.array(z.string()),
        finalExitCode: z.number().int().optional(),
      })
      .strict(),
    repairDurationMs: z.number().nonnegative().optional(),
    completedAt: z.string().optional(),
    rollbackStrategy: z.array(z.string()).optional(),
  })
  .strict();

export function validateTracePilotRepairArtifact(
  artifact: unknown,
): TracePilotRepairArtifact {
  const parsed = validateTracePilotRepairArtifactShape(artifact);
  assertNoSecretLikeValues('repair artifact', parsed);
  return parsed;
}

function validateTracePilotRepairArtifactShape(
  artifact: unknown,
): TracePilotRepairArtifact {
  return parseTracePilotSchema(
    'repair artifact',
    repairArtifactSchema,
    artifact,
  );
}

export function validateTracePilotCompletedRepairUpdate(
  update: unknown,
): TracePilotCompletedRepairUpdate {
  return parseTracePilotSchema(
    'completion update',
    completionUpdateSchema,
    update,
  );
}

function sanitizeArtifact(
  artifact: TracePilotRepairArtifact,
): TracePilotRepairArtifact {
  return {
    schemaVersion: artifact.schemaVersion,
    sessionId: sanitizeString(artifact.sessionId),
    phase: artifact.phase,
    failure: {
      summary: sanitizeString(artifact.failure.summary),
      rootCause: sanitizeString(artifact.failure.rootCause),
      signature: {
        ...artifact.failure.signature,
        id: sanitizeString(artifact.failure.signature.id),
        commandFamily: sanitizeString(artifact.failure.signature.commandFamily),
        diagnostics: artifact.failure.signature.diagnostics.map(sanitizeString),
        stackFrames: artifact.failure.signature.stackFrames.map(sanitizeString),
        files: artifact.failure.signature.files.map(sanitizeString),
        dependencies: sanitizeStringRecord(
          artifact.failure.signature.dependencies,
        ),
        outputSha256:
          artifact.failure.signature.outputSha256 === undefined
            ? undefined
            : sanitizeString(artifact.failure.signature.outputSha256),
        canonical: sanitizeRecord(artifact.failure.signature.canonical),
      },
    },
    phoenix: {
      tracesConsulted: artifact.phoenix.tracesConsulted.map(sanitizeString),
      mcpQueries: artifact.phoenix.mcpQueries.map((query) => ({
        serverName: sanitizeString(query.serverName),
        toolName: sanitizeString(query.toolName),
        arguments: sanitizeRecord(query.arguments),
        resultCount: query.resultCount,
        status: query.status,
        reason:
          query.reason === undefined ? undefined : sanitizeString(query.reason),
      })),
    },
    repair: {
      selectedStrategy: artifact.repair.selectedStrategy.map(sanitizeString),
      historicalMatches: artifact.repair.historicalMatches.map((match) => ({
        sessionId: sanitizeString(match.sessionId),
        traceId:
          match.traceId === undefined
            ? undefined
            : sanitizeString(match.traceId),
        similarityScore: match.similarityScore,
        historicalOutcomeScore: match.historicalOutcomeScore,
        matchedReasons: match.matchedReasons.map(sanitizeString),
      })),
      patches: artifact.repair.patches.map((patch) => ({
        file: sanitizeString(patch.file),
        linesAdded: patch.linesAdded,
        linesDeleted: patch.linesDeleted,
        description: sanitizeString(patch.description),
      })),
      filesModified: artifact.repair.filesModified.map(sanitizeString),
    },
    safety: {
      risk: {
        ...artifact.safety.risk,
        reasons: artifact.safety.risk.reasons.map(sanitizeString),
      },
      rollbackStrategy: artifact.safety.rollbackStrategy.map(sanitizeString),
    },
    verification: {
      matrix: artifact.verification.matrix.map((check) => ({
        ...check,
        command:
          check.command === undefined
            ? undefined
            : sanitizeString(check.command),
        reason: sanitizeString(check.reason),
        outputSha256:
          check.outputSha256 === undefined
            ? undefined
            : sanitizeString(check.outputSha256),
      })),
      regressionConfidence: artifact.verification.regressionConfidence,
    },
    confidence: {
      ...artifact.confidence,
      cappedBy: artifact.confidence.cappedBy.map(sanitizeString),
    },
    metrics: artifact.metrics,
    completion:
      artifact.completion === undefined
        ? undefined
        : {
            completedAt:
              artifact.completion.completedAt === undefined
                ? undefined
                : sanitizeString(artifact.completion.completedAt),
            attempts: artifact.completion.attempts,
            retryCommands:
              artifact.completion.retryCommands.map(sanitizeString),
            finalExitCode: artifact.completion.finalExitCode,
            verificationPassed: artifact.completion.verificationPassed,
          },
  };
}

function sanitizeString(value: string): string {
  return redactSensitiveText(value).value;
}

function sanitizeStringRecord(
  record: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[sanitizeString(key)] = sanitizeString(value);
  }
  return sanitized;
}

function sanitizeRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[sanitizeString(key)] = sanitizeUnknown(value);
  }
  return sanitized;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeUnknown(entry);
    }
    return sanitized;
  }
  return value;
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}
