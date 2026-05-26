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
    if (
      report.strictLiveProof &&
      !hasAnyEvidenceField(report, [
        'phoenix',
        'phoenixEnv',
        'causalTrace',
        'seed',
        'replay',
        'memory',
        'results',
      ])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofLevel'],
        message: 'strict proof requires live evidence fields',
      });
    }
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

function hasAnyEvidenceField(
  report: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.some((field) => {
    const value = report[field];
    return typeof value === 'object' && value !== null;
  });
}
