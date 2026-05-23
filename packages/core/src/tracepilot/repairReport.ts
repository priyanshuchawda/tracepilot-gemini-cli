/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stableStringify } from '../policy/stable-stringify.js';
import { redactSensitiveText } from '../telemetry/sanitize.js';
import type { TracePilotFailureSignature } from './failureSignature.js';
import type { TracePilotConfidenceScore } from './repairConfidence.js';
import type { TracePilotPatchRiskAssessment } from './repairRisk.js';
import type { TracePilotVerificationResult } from './verificationMatrix.js';

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
}

export function createTracePilotRepairArtifact(
  artifact: TracePilotRepairArtifact,
): TracePilotRepairArtifact {
  return sanitizeArtifact(artifact);
}

export function renderTracePilotRepairMarkdown(
  artifact: TracePilotRepairArtifact,
): string {
  const sanitized = sanitizeArtifact(artifact);
  const lines = [
    '# TracePilot Repair Report',
    '',
    `Session: ${sanitized.sessionId}`,
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
    ...sanitized.repair.patches.map(
      (patch) =>
        `- ${patch.file}: +${patch.linesAdded}/-${patch.linesDeleted} ${patch.description}`,
    ),
    '',
    '## Verification Matrix',
    ...sanitized.verification.matrix.map(
      (check) =>
        `- ${check.id}: ${check.status}${check.command ? ` (${check.command})` : ''}`,
    ),
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
  return `${stableStringify(sanitizeArtifact(artifact)).replace(/\0/g, '')}\n`;
}

function sanitizeArtifact(
  artifact: TracePilotRepairArtifact,
): TracePilotRepairArtifact {
  return {
    schemaVersion: artifact.schemaVersion,
    sessionId: sanitizeString(artifact.sessionId),
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
