/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  classifyTracePilotCommandRisk,
  type TracePilotCommandRiskLevel,
} from '../policy/tracepilot-command-risk.js';
import type { ErroredToolCall } from '../scheduler/types.js';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_COMMAND_RISK_LEVEL,
  GEMINI_CLI_OUTPUT_SHA256,
  GEMINI_CLI_PHOENIX_TRACE_IDS_CONSULTED,
  GEMINI_CLI_REPAIR_CONFIDENCE_SCORE,
  GEMINI_CLI_REPAIR_FINGERPRINT,
  GEMINI_CLI_REPAIR_REGRESSION_CONFIDENCE,
  GEMINI_CLI_REPAIR_RISK_LEVEL,
  GEMINI_CLI_REPAIR_ROOT_CAUSE,
  GEMINI_CLI_REPAIR_SIGNATURE_ID,
  GEMINI_CLI_REPAIR_SIMILARITY_SCORE,
  GEMINI_CLI_REPAIR_STRATEGY,
  GEMINI_CLI_REPAIR_VERIFICATION_PASSED,
  GeminiCliOperation,
  GEN_AI_TOOL_NAME,
} from '../telemetry/constants.js';
import type {
  PhoenixHistoricalRepairQueryResult,
  PhoenixSelfIntrospectionResult,
  PhoenixTraceEvidence,
} from '../telemetry/phoenixSelfIntrospection.js';
import { queryPhoenixForHistoricalRepairs } from '../telemetry/phoenixSelfIntrospection.js';
import { redactSensitiveText } from '../telemetry/sanitize.js';
import { runInDevTraceSpan } from '../telemetry/trace.js';
import {
  buildTracePilotFailureSignature,
  type TracePilotFailureSignature,
} from './failureSignature.js';
import {
  calculateTracePilotRepairConfidence,
  type TracePilotConfidenceScore,
} from './repairConfidence.js';
import {
  createTracePilotRepairFingerprint,
  rankTracePilotHistoricalRepairs,
  type TracePilotRepairCandidate,
  type TracePilotHistoricalRepairSession,
} from './repairMemory.js';
import {
  createTracePilotRepairArtifact,
  renderTracePilotRepairMarkdown,
  type TracePilotRepairArtifact,
} from './repairReport.js';
import {
  classifyTracePilotPatchRisk,
  type TracePilotPatchRiskAssessment,
} from './repairRisk.js';
import {
  buildTracePilotVerificationMatrix,
  calculateTracePilotRegressionConfidence,
  type TracePilotVerificationResult,
} from './verificationMatrix.js';

export interface TracePilotRepairPlan {
  created: boolean;
  source: 'phoenix_trace' | 'phoenix_memory' | 'unavailable';
  failedToolName: string;
  failedCommand?: string;
  commandRiskLevel: TracePilotCommandRiskLevel;
  traceEvidenceAvailable: boolean;
  referencedTraceEvidence: boolean;
  failureEvidence?: PhoenixTraceEvidence;
  failureSignature?: TracePilotFailureSignature;
  historicalRepairQuery?: PhoenixHistoricalRepairQueryResult;
  historicalRepairCandidates?: TracePilotRepairCandidate[];
  confidence?: TracePilotConfidenceScore;
  patchRisk?: TracePilotPatchRiskAssessment;
  verificationMatrix?: TracePilotVerificationResult[];
  repairArtifact?: TracePilotRepairArtifact;
  repairReportMarkdown?: string;
  proposedFix: string;
  verificationCommand?: string;
  unavailableReason?: string;
  text: string;
}

export async function buildTraceEvidenceRepairPlan(
  config: Config,
  call: ErroredToolCall,
  introspection: PhoenixSelfIntrospectionResult,
): Promise<TracePilotRepairPlan> {
  const startedAt = Date.now();
  const failedCommand = getStringArg(call.request.args, 'command');
  const risk = classifyTracePilotCommandRisk(failedCommand);

  return runInDevTraceSpan(
    {
      operation: GeminiCliOperation.RepairPlan,
      logPrompts: config.getTelemetryLogPromptsEnabled(),
      tracesEnabled: config.getTelemetryTracesEnabled(),
      sessionId: config.getSessionId(),
      attributes: {
        [GEN_AI_TOOL_NAME]: call.request.name,
        [GEMINI_CLI_COMMAND_RISK_LEVEL]: risk.level,
      },
    },
    async ({ metadata }) => {
      metadata.input = {
        callId: call.request.callId,
        failedToolName: call.request.name,
        failedCommand: redactOptional(failedCommand),
        commandRiskLevel: risk.level,
        traceEvidenceAvailable: introspection.available,
      };

      const failureEvidence = introspection.available
        ? {
            ...introspection.evidence,
            outputPreview: redactOptional(introspection.evidence.outputPreview),
          }
        : undefined;
      const failureSignature = buildFailureSignature(
        failedCommand,
        failureEvidence,
      );
      const historicalRepairQuery = await queryPhoenixForHistoricalRepairs(
        config,
        failureSignature,
      );
      const historicalRepairCandidates = rankTracePilotHistoricalRepairs(
        failureSignature,
        toHistoricalRepairSessions(failureSignature, historicalRepairQuery),
      );
      const patchRisk = classifyTracePilotPatchRisk({
        filesModified: [],
        destructiveCommandBlocked: risk.level === 'blocked',
      });
      const verificationMatrix = buildTracePilotVerificationMatrix({
        failedCommand: failedCommand
          ? redactOptional(failedCommand)
          : undefined,
        filesModified: [],
      }).map(
        (check): TracePilotVerificationResult => ({
          ...check,
          status: 'skipped',
        }),
      );
      const regressionConfidence =
        calculateTracePilotRegressionConfidence(verificationMatrix);
      const confidence = calculateTracePilotRepairConfidence({
        topCandidate: historicalRepairCandidates[0],
        phoenixEvidenceAvailable:
          introspection.available || historicalRepairQuery.available,
        verificationCoverageScore: verificationMatrix.length > 0 ? 0.45 : 0,
        patchMinimalityScore: 1,
        riskLevel: patchRisk.level,
        regressionPassed: regressionConfidence > 0.9,
      });
      const repairFingerprint = createTracePilotRepairFingerprint({
        strategy: inferRepairStrategy(
          historicalRepairCandidates,
          introspection.available,
        ),
        filesModified: [],
        verificationCommands: verificationMatrix
          .map((check) => check.command)
          .filter((value): value is string => value !== undefined),
      });
      const repairArtifact = createTracePilotRepairArtifact({
        schemaVersion: 1,
        sessionId: config.getSessionId(),
        failure: {
          summary: summarizeFailure(
            call.request.name,
            failedCommand,
            failureEvidence,
          ),
          rootCause: failureSignature.taxonomy,
          signature: failureSignature,
        },
        phoenix: {
          tracesConsulted: getTraceIds(historicalRepairCandidates),
          mcpQueries: [
            {
              serverName: 'phoenix',
              toolName: 'get-spans',
              arguments: {
                signatureId: failureSignature.id,
                taxonomy: failureSignature.taxonomy,
              },
              resultCount: historicalRepairQuery.evidence.length,
              status: historicalRepairQuery.available
                ? 'ok'
                : historicalRepairQuery.attempted
                  ? 'error'
                  : 'skipped',
              reason: historicalRepairQuery.available
                ? undefined
                : historicalRepairQuery.reason,
            },
          ],
        },
        repair: {
          selectedStrategy: inferRepairStrategy(
            historicalRepairCandidates,
            introspection.available,
          ),
          historicalMatches: historicalRepairCandidates.map((candidate) => ({
            sessionId: candidate.session.sessionId,
            traceId: candidate.session.traceId,
            similarityScore: candidate.similarityScore,
            historicalOutcomeScore: candidate.historicalOutcomeScore,
            matchedReasons: candidate.matchedReasons,
          })),
          patches: [],
          filesModified: [],
        },
        safety: {
          risk: patchRisk,
          rollbackStrategy: [
            'No patch has been applied at planning time.',
            'If a patch is applied later, capture a diff and use git apply -R for rollback.',
          ],
        },
        verification: {
          matrix: verificationMatrix,
          regressionConfidence,
        },
        confidence,
        metrics: {
          repairDurationMs: Date.now() - startedAt,
          retriesRequired: 0,
          unsafeCommandsBlocked: risk.level === 'blocked' ? 1 : 0,
        },
      });
      const plan = introspection.available
        ? createPlanFromEvidence(
            call.request.name,
            failedCommand,
            risk.level,
            failureEvidence ?? {},
            failureSignature,
            historicalRepairQuery,
            historicalRepairCandidates,
            confidence,
            patchRisk,
            verificationMatrix,
            repairArtifact,
            repairFingerprint,
          )
        : createUnavailablePlan(
            call.request.name,
            failedCommand,
            risk.level,
            introspection.reason,
            failureSignature,
            historicalRepairQuery,
            historicalRepairCandidates,
            confidence,
            patchRisk,
            verificationMatrix,
            repairArtifact,
            repairFingerprint,
          );

      if (plan.failureEvidence?.exitCode !== undefined) {
        metadata.attributes[GEMINI_CLI_COMMAND_EXIT_CODE] =
          plan.failureEvidence.exitCode;
      }
      if (plan.failureEvidence?.outputSha256) {
        metadata.attributes[GEMINI_CLI_OUTPUT_SHA256] =
          plan.failureEvidence.outputSha256;
      }
      metadata.attributes['gemini_cli.repair.trace_evidence_available'] =
        plan.traceEvidenceAvailable;
      metadata.attributes['gemini_cli.repair.referenced_trace_evidence'] =
        plan.referencedTraceEvidence;
      metadata.attributes[GEMINI_CLI_REPAIR_SIGNATURE_ID] = failureSignature.id;
      metadata.attributes[GEMINI_CLI_REPAIR_ROOT_CAUSE] =
        failureSignature.taxonomy;
      metadata.attributes[GEMINI_CLI_REPAIR_CONFIDENCE_SCORE] =
        confidence.score;
      metadata.attributes[GEMINI_CLI_REPAIR_RISK_LEVEL] = patchRisk.level;
      metadata.attributes[GEMINI_CLI_REPAIR_REGRESSION_CONFIDENCE] =
        regressionConfidence;
      metadata.attributes[GEMINI_CLI_REPAIR_SIMILARITY_SCORE] =
        historicalRepairCandidates[0]?.similarityScore ?? 0;
      metadata.attributes[GEMINI_CLI_REPAIR_VERIFICATION_PASSED] = false;
      metadata.attributes[GEMINI_CLI_REPAIR_FINGERPRINT] = repairFingerprint;
      metadata.attributes[GEMINI_CLI_REPAIR_STRATEGY] = JSON.stringify(
        repairArtifact.repair.selectedStrategy,
      );
      metadata.attributes[GEMINI_CLI_PHOENIX_TRACE_IDS_CONSULTED] =
        repairArtifact.phoenix.tracesConsulted.join(',');
      metadata.output = {
        created: plan.created,
        source: plan.source,
        failedToolName: plan.failedToolName,
        failedCommand: plan.failedCommand,
        commandRiskLevel: plan.commandRiskLevel,
        failureSignature: plan.failureSignature,
        failureEvidence: plan.failureEvidence,
        historicalRepairCandidates: plan.historicalRepairCandidates?.map(
          (candidate) => ({
            sessionId: candidate.session.sessionId,
            traceId: candidate.session.traceId,
            similarityScore: candidate.similarityScore,
            historicalOutcomeScore: candidate.historicalOutcomeScore,
            matchedReasons: candidate.matchedReasons,
          }),
        ),
        confidence: plan.confidence,
        patchRisk: plan.patchRisk,
        verificationMatrix: plan.verificationMatrix,
        proposedFix: plan.proposedFix,
        verificationCommand: plan.verificationCommand,
        unavailableReason: plan.unavailableReason,
      };
      return plan;
    },
  );
}

function createPlanFromEvidence(
  failedToolName: string,
  failedCommand: string | undefined,
  commandRiskLevel: TracePilotCommandRiskLevel,
  evidence: PhoenixTraceEvidence,
  failureSignature: TracePilotFailureSignature,
  historicalRepairQuery: PhoenixHistoricalRepairQueryResult,
  historicalRepairCandidates: TracePilotRepairCandidate[],
  confidence: TracePilotConfidenceScore,
  patchRisk: TracePilotPatchRiskAssessment,
  verificationMatrix: TracePilotVerificationResult[],
  repairArtifact: TracePilotRepairArtifact,
  repairFingerprint: string,
): TracePilotRepairPlan {
  const verificationCommand = inferVerificationCommand(failedCommand);
  const selectedStrategy = inferRepairStrategy(
    historicalRepairCandidates,
    true,
  );
  const proposedFix = selectedStrategy.join(' ');
  const text = [
    'TracePilot repair plan:',
    `failed_tool=${failedToolName}`,
    `failed_command=${redactOptional(failedCommand) ?? 'unknown'}`,
    `command_risk=${commandRiskLevel}`,
    `failure_signature=${failureSignature.id}`,
    `root_cause_taxonomy=${failureSignature.taxonomy}`,
    `trace_span=${evidence.spanName ?? 'unknown'}`,
    `trace_tool=${evidence.toolName ?? 'unknown'}`,
    `exit_code=${evidence.exitCode ?? 'unknown'}`,
    `output_sha256=${evidence.outputSha256 ?? 'unknown'}`,
    `failure_evidence=${evidence.outputPreview ?? '(empty)'}`,
    `phoenix_historical_query=${historicalRepairQuery.available ? 'available' : 'unavailable'}`,
    `historical_repairs_found=${historicalRepairCandidates.length}`,
    `repair_fingerprint=${repairFingerprint}`,
    `selected_strategy=${selectedStrategy.join(' | ')}`,
    `confidence_score=${Math.round(confidence.score * 100)}%`,
    `risk_level=${patchRisk.level}`,
    `verification_matrix=${verificationMatrix.map((check) => check.id).join(',')}`,
    `proposed_fix=${proposedFix}`,
    `verification_command=${verificationCommand ?? 'rerun failed tool'}`,
  ].join('\n');

  return {
    created: true,
    source: historicalRepairQuery.available
      ? 'phoenix_memory'
      : 'phoenix_trace',
    failedToolName,
    failedCommand: redactOptional(failedCommand),
    commandRiskLevel,
    traceEvidenceAvailable: true,
    referencedTraceEvidence: true,
    failureEvidence: evidence,
    failureSignature,
    historicalRepairQuery,
    historicalRepairCandidates,
    confidence,
    patchRisk,
    verificationMatrix,
    repairArtifact,
    repairReportMarkdown: renderTracePilotRepairMarkdown(repairArtifact),
    proposedFix,
    verificationCommand,
    text,
  };
}

function createUnavailablePlan(
  failedToolName: string,
  failedCommand: string | undefined,
  commandRiskLevel: TracePilotCommandRiskLevel,
  reason: string,
  failureSignature: TracePilotFailureSignature,
  historicalRepairQuery: PhoenixHistoricalRepairQueryResult,
  historicalRepairCandidates: TracePilotRepairCandidate[],
  confidence: TracePilotConfidenceScore,
  patchRisk: TracePilotPatchRiskAssessment,
  verificationMatrix: TracePilotVerificationResult[],
  repairArtifact: TracePilotRepairArtifact,
  repairFingerprint: string,
): TracePilotRepairPlan {
  const selectedStrategy = inferRepairStrategy(
    historicalRepairCandidates,
    false,
  );
  const proposedFix = selectedStrategy.join(' ');
  const verificationCommand = inferVerificationCommand(failedCommand);
  const text = [
    'TracePilot repair plan unavailable:',
    `failed_tool=${failedToolName}`,
    `failed_command=${redactOptional(failedCommand) ?? 'unknown'}`,
    `command_risk=${commandRiskLevel}`,
    `failure_signature=${failureSignature.id}`,
    `root_cause_taxonomy=${failureSignature.taxonomy}`,
    `reason=${redactSensitiveText(reason).value}`,
    `phoenix_historical_query=${historicalRepairQuery.available ? 'available' : 'unavailable'}`,
    `historical_repairs_found=${historicalRepairCandidates.length}`,
    `repair_fingerprint=${repairFingerprint}`,
    `selected_strategy=${selectedStrategy.join(' | ')}`,
    `confidence_score=${Math.round(confidence.score * 100)}%`,
    `risk_level=${patchRisk.level}`,
    `verification_matrix=${verificationMatrix.map((check) => check.id).join(',')}`,
    `next_step=${proposedFix}`,
    `verification_command=${verificationCommand ?? 'rerun failed tool'}`,
  ].join('\n');

  return {
    created: false,
    source: 'unavailable',
    failedToolName,
    failedCommand: redactOptional(failedCommand),
    commandRiskLevel,
    traceEvidenceAvailable: false,
    referencedTraceEvidence: false,
    failureSignature,
    historicalRepairQuery,
    historicalRepairCandidates,
    confidence,
    patchRisk,
    verificationMatrix,
    repairArtifact,
    repairReportMarkdown: renderTracePilotRepairMarkdown(repairArtifact),
    proposedFix,
    verificationCommand,
    unavailableReason: redactSensitiveText(reason).value,
    text,
  };
}

function inferVerificationCommand(
  failedCommand: string | undefined,
): string | undefined {
  const command = failedCommand?.trim();
  if (!command) {
    return undefined;
  }
  if (
    /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|typecheck|lint))\b/i.test(
      command,
    )
  ) {
    return redactOptional(command);
  }
  return redactOptional(command);
}

function getStringArg(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' ? value : undefined;
}

function redactOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSensitiveText(value).value;
}

function buildFailureSignature(
  failedCommand: string | undefined,
  evidence: PhoenixTraceEvidence | undefined,
): TracePilotFailureSignature {
  return buildTracePilotFailureSignature({
    command: failedCommand,
    exitCode: evidence?.exitCode,
    outputPreview: evidence?.outputPreview,
    outputSha256: evidence?.outputSha256,
  });
}

function toHistoricalRepairSessions(
  signature: TracePilotFailureSignature,
  query: PhoenixHistoricalRepairQueryResult,
): TracePilotHistoricalRepairSession[] {
  return query.evidence.map((item, index) => ({
    sessionId:
      item.sessionId ??
      item.traceId ??
      item.repairFingerprint ??
      `phoenix-historical-${index}`,
    traceId: item.traceId,
    signature,
    repairFingerprint:
      item.repairFingerprint ??
      createTracePilotRepairFingerprint({
        strategy: item.strategy ?? ['reuse verified Phoenix repair evidence'],
        filesModified: [],
        verificationCommands: [],
      }),
    rootCause: item.rootCause ?? signature.taxonomy,
    strategy: item.strategy ?? ['reuse verified Phoenix repair evidence'],
    outcome: item.verificationPassed === false ? 'failed' : 'verified',
    attempts: 1,
    verificationPassed: item.verificationPassed !== false,
    regressionPassed: item.verificationPassed !== false,
    tracesConsulted: [
      {
        spanName: 'gemini_cli.chain.repair_memory_retrieve',
        outputPreview: item.outputPreview,
        outputSha256: item.outputSha256,
      },
    ],
  }));
}

function inferRepairStrategy(
  candidates: TracePilotRepairCandidate[],
  traceEvidenceAvailable: boolean,
): string[] {
  const historicalStrategy = candidates[0]?.session.strategy;
  if (historicalStrategy && historicalStrategy.length > 0) {
    return historicalStrategy;
  }
  if (traceEvidenceAvailable) {
    return [
      'Use Phoenix trace evidence and output hash as the primary repair evidence.',
      'Patch the smallest code or configuration change that explains the traced failure.',
      'Rerun the failed command and the regression verification matrix.',
    ];
  }
  return [
    'Phoenix trace evidence is unavailable; inspect the local tool error conservatively.',
    'Avoid broad rewrites and prefer a minimal patch tied to the observed failure.',
    'Rerun the failed command and the regression verification matrix.',
  ];
}

function summarizeFailure(
  failedToolName: string,
  failedCommand: string | undefined,
  evidence: PhoenixTraceEvidence | undefined,
): string {
  return [
    `tool=${failedToolName}`,
    `command=${redactOptional(failedCommand) ?? 'unknown'}`,
    `exit_code=${evidence?.exitCode ?? 'unknown'}`,
    `output_sha256=${evidence?.outputSha256 ?? 'unknown'}`,
  ].join(' ');
}

function getTraceIds(candidates: TracePilotRepairCandidate[]): string[] {
  return candidates
    .map((candidate) => candidate.session.traceId)
    .filter((value): value is string => value !== undefined);
}
