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
  GeminiCliOperation,
  GEN_AI_TOOL_NAME,
} from '../telemetry/constants.js';
import type {
  PhoenixSelfIntrospectionResult,
  PhoenixTraceEvidence,
} from '../telemetry/phoenixSelfIntrospection.js';
import { redactSensitiveText } from '../telemetry/sanitize.js';
import { runInDevTraceSpan } from '../telemetry/trace.js';

export interface TracePilotRepairPlan {
  created: boolean;
  source: 'phoenix_trace' | 'unavailable';
  failedToolName: string;
  failedCommand?: string;
  commandRiskLevel: TracePilotCommandRiskLevel;
  traceEvidenceAvailable: boolean;
  referencedTraceEvidence: boolean;
  failureEvidence?: PhoenixTraceEvidence;
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

      const plan = introspection.available
        ? createPlanFromEvidence(call.request.name, failedCommand, risk.level, {
            ...introspection.evidence,
            outputPreview: redactOptional(introspection.evidence.outputPreview),
          })
        : createUnavailablePlan(
            call.request.name,
            failedCommand,
            risk.level,
            introspection.reason,
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
      metadata.output = {
        created: plan.created,
        source: plan.source,
        failedToolName: plan.failedToolName,
        failedCommand: plan.failedCommand,
        commandRiskLevel: plan.commandRiskLevel,
        failureEvidence: plan.failureEvidence,
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
): TracePilotRepairPlan {
  const verificationCommand = inferVerificationCommand(failedCommand);
  const proposedFix =
    'Use the Phoenix trace evidence preview and output hash to identify the failing assertion or command error, then patch the smallest code/config change that addresses that traced failure.';
  const text = [
    'TracePilot repair plan:',
    `failed_tool=${failedToolName}`,
    `failed_command=${redactOptional(failedCommand) ?? 'unknown'}`,
    `command_risk=${commandRiskLevel}`,
    `trace_span=${evidence.spanName ?? 'unknown'}`,
    `trace_tool=${evidence.toolName ?? 'unknown'}`,
    `exit_code=${evidence.exitCode ?? 'unknown'}`,
    `output_sha256=${evidence.outputSha256 ?? 'unknown'}`,
    `failure_evidence=${evidence.outputPreview ?? '(empty)'}`,
    `proposed_fix=${proposedFix}`,
    `verification_command=${verificationCommand ?? 'rerun failed tool'}`,
  ].join('\n');

  return {
    created: true,
    source: 'phoenix_trace',
    failedToolName,
    failedCommand: redactOptional(failedCommand),
    commandRiskLevel,
    traceEvidenceAvailable: true,
    referencedTraceEvidence: true,
    failureEvidence: evidence,
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
): TracePilotRepairPlan {
  const proposedFix =
    'Phoenix trace evidence is unavailable, so defer trace-based repair planning and inspect the local tool error conservatively.';
  const verificationCommand = inferVerificationCommand(failedCommand);
  const text = [
    'TracePilot repair plan unavailable:',
    `failed_tool=${failedToolName}`,
    `failed_command=${redactOptional(failedCommand) ?? 'unknown'}`,
    `command_risk=${commandRiskLevel}`,
    `reason=${redactSensitiveText(reason).value}`,
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
