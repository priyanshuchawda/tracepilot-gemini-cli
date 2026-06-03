/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { stableStringify } from '../policy/stable-stringify.js';
import {
  assertNoSecretLikeValues,
  parseTracePilotSchema,
} from './runtimeValidation.js';
import {
  isStrictTracePilotProofLevel,
  TRACEPILOT_PROOF_LEVELS,
  type TracePilotProofLevel,
} from './proofLevel.js';

export type TracePilotProofReport = Record<string, unknown> & {
  ok: boolean;
  proofLevel: TracePilotProofLevel;
  strictLiveProof: boolean;
  proofSummary: string;
};

const proofLevelSchema = z.enum([
  TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE,
  TRACEPILOT_PROOF_LEVELS.CONTROLLED_SUBSTITUTE,
  TRACEPILOT_PROOF_LEVELS.DEGRADED_GEMINI,
  TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX,
  TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX,
  TRACEPILOT_PROOF_LEVELS.HOSTED_CLOUD_RUN,
]);

const proofReportSchema: z.ZodType<TracePilotProofReport> = z
  .object({
    ok: z.boolean(),
    proofLevel: proofLevelSchema,
    strictLiveProof: z.boolean(),
    proofSummary: z.string().min(1),
    agent: z
      .object({
        model: z.string().optional(),
        quotaFallbackUsed: z.boolean().optional(),
        attempts: z
          .array(
            z
              .object({
                model: z.string().optional(),
                exitCode: z.number().int().optional(),
                reason: z.string().optional(),
              })
              .catchall(z.unknown()),
          )
          .optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown())
  .superRefine((report, context) => {
    const expectedStrictLive = isStrictTracePilotProofLevel(report.proofLevel);
    if (report.strictLiveProof !== expectedStrictLive) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strictLiveProof'],
        message: 'strictLiveProof must match proofLevel',
      });
    }
    if (report.strictLiveProof && !report.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ok'],
        message: 'strictLiveProof requires ok=true',
      });
    }
    validateStrictProofEvidence(report, context);
  });

export function validateTracePilotProofReport(
  report: unknown,
): TracePilotProofReport {
  const parsed = parseTracePilotSchema(
    'proof report',
    proofReportSchema,
    report,
  );
  assertNoSecretLikeValues('proof report', parsed);
  return parsed;
}

export function stableTracePilotProofReportJson(report: unknown): string {
  return `${stableStringify(validateTracePilotProofReport(report)).replace(/\0/g, '')}\n`;
}

function validateStrictProofEvidence(
  report: TracePilotProofReport,
  context: z.RefinementCtx,
): void {
  if (!report.strictLiveProof) {
    return;
  }

  if (report.proofLevel === TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX) {
    if (!hasLivePhoenixEvidence(report)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phoenix'],
        message:
          'live_phoenix proof requires phoenix.visible=true and phoenix.queryable=true',
      });
    }
    return;
  }

  if (report.proofLevel === TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX) {
    if (!hasLiveGeminiPhoenixEvidence(report)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofLevel'],
        message:
          'live_gemini_phoenix proof requires a completed causal trace or live memory replay evidence',
      });
    }
    return;
  }

  if (report.proofLevel === TRACEPILOT_PROOF_LEVELS.HOSTED_CLOUD_RUN) {
    if (!hasHostedCloudRunEvidence(report)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofLevel'],
        message:
          'hosted_cloud_run proof requires positive hosted Cloud Run evidence',
      });
    }
  }
}

function hasLivePhoenixEvidence(report: TracePilotProofReport): boolean {
  const phoenix = getRecord(report['phoenix']);
  return (
    getBoolean(phoenix, 'visible') === true &&
    getBoolean(phoenix, 'queryable') === true
  );
}

function hasLiveGeminiPhoenixEvidence(report: TracePilotProofReport): boolean {
  const causalTrace = getRecord(report['causalTrace']);
  if (getBoolean(causalTrace, 'chainComplete')) {
    return true;
  }

  const memory = getRecord(report['memory']);
  const seedOutcome = getRecord(report['seedOutcome']);
  const replay = getRecord(report['replay']);
  return (
    getBoolean(memory, 'matched') === true &&
    getBoolean(memory, 'simulated') === false &&
    getBoolean(seedOutcome, 'visible') === true &&
    getBoolean(replay, 'ok') === true
  );
}

function hasHostedCloudRunEvidence(report: TracePilotProofReport): boolean {
  if (getBoolean(report, 'cloudRunDetected') === true) {
    return true;
  }
  const cloudRun = getRecord(report['cloudRun']);
  if (
    getBoolean(cloudRun, 'detected') === true ||
    getBoolean(cloudRun, 'verified') === true
  ) {
    return true;
  }
  const hosted = getRecord(report['hostedCloudRun']);
  return getBoolean(hosted, 'verified') === true;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
