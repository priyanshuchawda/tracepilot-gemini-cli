/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { stableStringify } from '../policy/stable-stringify.js';
import { redactSensitiveText } from '../telemetry/sanitize.js';
import {
  assertNoSecretLikeValues,
  parseTracePilotSchema,
} from './runtimeValidation.js';
import {
  validateTracePilotEvalReport,
  type TracePilotEvalReport,
} from './evals.js';
import {
  validateTracePilotRepairArtifact,
  type TracePilotRepairArtifact,
} from './repairReport.js';

export const TRACEPILOT_JUDGE_CRITERIA = [
  'correctness',
  'minimality',
  'evidence_use',
  'safety',
  'confidence',
] as const;

export type TracePilotJudgeCriterion =
  (typeof TRACEPILOT_JUDGE_CRITERIA)[number];

export interface TracePilotJudgeInput {
  schemaVersion: 1;
  repair: {
    sessionId: string;
    phase: string;
    failureSummary: string;
    rootCause: string;
    selectedStrategy: string[];
    filesModified: string[];
    patchCount: number;
    verificationPassed: boolean;
    confidenceScore: number;
    phoenixTraceCount: number;
  };
  deterministicEval: {
    ok: boolean;
    passCount: number;
    failCount: number;
    results: Array<{
      id: string;
      status: string;
      failureReason?: string;
    }>;
  };
  safety: {
    riskLevel: string;
    requiresApproval: boolean;
    rollbackRequired: boolean;
  };
}

export interface TracePilotJudgeCriterionScore {
  id: TracePilotJudgeCriterion;
  score: number;
  rationale: string;
  evidence: string[];
}

export type TracePilotJudgeResult =
  | {
      schemaVersion: 1;
      mode: 'unavailable';
      ok: false;
      strictLiveProof: false;
      generatedAt: string;
      summary: string;
      unavailableReason: string;
    }
  | {
      schemaVersion: 1;
      mode: 'scored';
      ok: boolean;
      strictLiveProof: false;
      generatedAt: string;
      summary: string;
      model?: string;
      overallScore: number;
      criteria: TracePilotJudgeCriterionScore[];
    };

export function createTracePilotJudgeInput(input: {
  repair: TracePilotRepairArtifact;
  deterministicEval: TracePilotEvalReport;
}): TracePilotJudgeInput {
  const repair = validateTracePilotRepairArtifact(input.repair);
  const deterministicEval = validateTracePilotEvalReport(
    input.deterministicEval,
  );
  const passCount = deterministicEval.results.filter(
    (result) => result.status === 'pass',
  ).length;
  const failCount = deterministicEval.results.length - passCount;
  return validateTracePilotJudgeInput({
    schemaVersion: 1,
    repair: {
      sessionId: sanitizeString(repair.sessionId),
      phase: repair.phase,
      failureSummary: sanitizeString(repair.failure.summary),
      rootCause: sanitizeString(repair.failure.rootCause),
      selectedStrategy: repair.repair.selectedStrategy.map(sanitizeString),
      filesModified: repair.repair.filesModified.map(sanitizeString),
      patchCount: repair.repair.patches.length,
      verificationPassed: repair.completion?.verificationPassed === true,
      confidenceScore: repair.confidence.score,
      phoenixTraceCount: repair.phoenix.tracesConsulted.length,
    },
    deterministicEval: {
      ok: deterministicEval.ok,
      passCount,
      failCount,
      results: deterministicEval.results.map((result) => ({
        id: result.id,
        status: result.status,
        failureReason:
          result.failureReason === undefined
            ? undefined
            : sanitizeString(result.failureReason),
      })),
    },
    safety: {
      riskLevel: repair.safety.risk.level,
      requiresApproval: repair.safety.risk.requiresApproval,
      rollbackRequired: repair.safety.risk.rollbackRequired,
    },
  });
}

export function createTracePilotJudgeUnavailableResult(
  reason: string,
  generatedAt = new Date().toISOString(),
): TracePilotJudgeResult {
  return validateTracePilotJudgeResult({
    schemaVersion: 1,
    mode: 'unavailable',
    ok: false,
    strictLiveProof: false,
    generatedAt,
    summary: 'Repair-quality judge evidence unavailable.',
    unavailableReason: sanitizeString(reason),
  });
}

export function validateTracePilotJudgeInput(
  input: unknown,
): TracePilotJudgeInput {
  const parsed = parseTracePilotSchema('judge input', judgeInputSchema, input);
  assertNoSecretLikeValues('judge input', parsed);
  return parsed;
}

export function validateTracePilotJudgeResult(
  result: unknown,
): TracePilotJudgeResult {
  const parsed = parseTracePilotSchema(
    'judge result',
    judgeResultSchema,
    result,
  );
  assertNoSecretLikeValues('judge result', parsed);
  return parsed;
}

export function stableTracePilotJudgeInputJson(
  input: TracePilotJudgeInput,
): string {
  return `${stableStringify(validateTracePilotJudgeInput(input)).replace(/\0/g, '')}\n`;
}

export function stableTracePilotJudgeResultJson(
  result: TracePilotJudgeResult,
): string {
  return `${stableStringify(validateTracePilotJudgeResult(result)).replace(/\0/g, '')}\n`;
}

export function renderTracePilotJudgeMarkdown(
  result: TracePilotJudgeResult,
): string {
  const validated = validateTracePilotJudgeResult(result);
  if (validated.mode === 'unavailable') {
    return [
      '# TracePilot Repair-Quality Judge',
      '',
      'Mode: unavailable',
      'Strict live proof: false',
      `Reason: ${validated.unavailableReason}`,
      '',
    ].join('\n');
  }

  return [
    '# TracePilot Repair-Quality Judge',
    '',
    'Mode: scored',
    'Strict live proof: false',
    `Overall score: ${formatScore(validated.overallScore)}`,
    `Summary: ${validated.summary}`,
    '',
    '## Criteria',
    ...validated.criteria.map(
      (criterion) =>
        `- ${criterion.id}: ${formatScore(criterion.score)} - ${criterion.rationale}`,
    ),
    '',
  ].join('\n');
}

const judgeCriterionSchema = z.enum(TRACEPILOT_JUDGE_CRITERIA);

const judgeInputSchema: z.ZodType<TracePilotJudgeInput> = z
  .object({
    schemaVersion: z.literal(1),
    repair: z
      .object({
        sessionId: z.string(),
        phase: z.string(),
        failureSummary: z.string(),
        rootCause: z.string(),
        selectedStrategy: z.array(z.string()).min(1),
        filesModified: z.array(z.string()),
        patchCount: z.number().int().nonnegative(),
        verificationPassed: z.boolean(),
        confidenceScore: z.number().min(0).max(1),
        phoenixTraceCount: z.number().int().nonnegative(),
      })
      .strict(),
    deterministicEval: z
      .object({
        ok: z.boolean(),
        passCount: z.number().int().nonnegative(),
        failCount: z.number().int().nonnegative(),
        results: z.array(
          z
            .object({
              id: z.string(),
              status: z.string(),
              failureReason: z.string().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    safety: z
      .object({
        riskLevel: z.string(),
        requiresApproval: z.boolean(),
        rollbackRequired: z.boolean(),
      })
      .strict(),
  })
  .strict();

const criterionScoreSchema: z.ZodType<TracePilotJudgeCriterionScore> = z
  .object({
    id: judgeCriterionSchema,
    score: z.number().min(0).max(1),
    rationale: z.string().min(1),
    evidence: z.array(z.string()),
  })
  .strict();

const unavailableJudgeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('unavailable'),
    ok: z.literal(false),
    strictLiveProof: z.literal(false),
    generatedAt: z.string().datetime(),
    summary: z.string().min(1),
    unavailableReason: z.string().min(1),
  })
  .strict();

const scoredJudgeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('scored'),
    ok: z.boolean(),
    strictLiveProof: z.literal(false),
    generatedAt: z.string().datetime(),
    summary: z.string().min(1),
    model: z.string().optional(),
    overallScore: z.number().min(0).max(1),
    criteria: z
      .array(criterionScoreSchema)
      .length(TRACEPILOT_JUDGE_CRITERIA.length),
  })
  .strict()
  .superRefine((result, context) => {
    const seen = new Set(result.criteria.map((criterion) => criterion.id));
    for (const criterion of TRACEPILOT_JUDGE_CRITERIA) {
      if (!seen.has(criterion)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria'],
          message: `missing criterion ${criterion}`,
        });
      }
    }
  });

const judgeResultSchema: z.ZodType<TracePilotJudgeResult> = z.union([
  unavailableJudgeResultSchema,
  scoredJudgeResultSchema,
]);

function sanitizeString(value: string): string {
  return redactSensitiveText(value).value;
}

function formatScore(value: number): string {
  return `${Math.round(value * 100)}%`;
}
