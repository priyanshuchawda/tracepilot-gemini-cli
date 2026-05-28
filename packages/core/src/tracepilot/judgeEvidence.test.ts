/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTracePilotFailureSignature } from './failureSignature.js';
import {
  createTracePilotJudgeInput,
  createTracePilotJudgeUnavailableResult,
  renderTracePilotJudgeMarkdown,
  stableTracePilotJudgeInputJson,
  stableTracePilotJudgeResultJson,
  TRACEPILOT_JUDGE_CRITERIA,
  validateTracePilotJudgeInput,
  validateTracePilotJudgeResult,
  type TracePilotJudgeResult,
} from './judgeEvidence.js';
import { calculateTracePilotRepairConfidence } from './repairConfidence.js';
import {
  completeTracePilotRepairArtifact,
  createTracePilotRepairArtifact,
} from './repairReport.js';
import { classifyTracePilotPatchRisk } from './repairRisk.js';
import { runTracePilotEvals } from './evals.js';

describe('TracePilot judge evidence contract', () => {
  it('builds sanitized judge input from repair and deterministic eval evidence', () => {
    const judgeInput = createTracePilotJudgeInput({
      repair: makeCompletedRepairArtifact(),
      deterministicEval: makePassingEvalReport(),
    });
    const json = stableTracePilotJudgeInputJson(judgeInput);

    expect(judgeInput).toMatchObject({
      schemaVersion: 1,
      repair: {
        phase: 'verified',
        verificationPassed: true,
        patchCount: 1,
        phoenixTraceCount: 1,
      },
      deterministicEval: {
        ok: true,
        passCount: 7,
        failCount: 0,
      },
    });
    expect(json).not.toContain('sk-proj-secret');
    expect(json).not.toContain('AIzaSecret');
    expect(json).toContain('[REDACTED]');
  });

  it('creates a non-strict unavailable result for missing judge execution', () => {
    const result = createTracePilotJudgeUnavailableResult(
      'Gemini judge skipped because GEMINI_API_KEY=AIzaSecret0000000000000000 was unavailable.',
      '2026-05-27T00:00:00.000Z',
    );
    const markdown = renderTracePilotJudgeMarkdown(result);
    const json = stableTracePilotJudgeResultJson(result);

    expect(result).toMatchObject({
      mode: 'unavailable',
      ok: false,
      strictLiveProof: false,
    });
    expect(markdown).toContain('Mode: unavailable');
    expect(json).not.toContain('AIzaSecret');
    expect(json).toContain('[REDACTED]');
  });

  it('validates and renders scored judge criteria deterministically', () => {
    const result: TracePilotJudgeResult = {
      schemaVersion: 1,
      mode: 'scored',
      ok: true,
      strictLiveProof: false,
      generatedAt: '2026-05-27T00:00:00.000Z',
      summary: 'Repair is correct, minimal, evidence-backed, and safe.',
      model: 'gemini-test-judge',
      overallScore: 0.92,
      criteria: TRACEPILOT_JUDGE_CRITERIA.map((criterion) => ({
        id: criterion,
        score: 0.9,
        rationale: `${criterion} criterion passed`,
        evidence: ['deterministic fixture'],
      })),
    };

    expect(validateTracePilotJudgeResult(result)).toEqual(result);
    expect(renderTracePilotJudgeMarkdown(result)).toContain(
      'Overall score: 92%',
    );
  });

  it('rejects malformed or secret-like judge payloads', () => {
    expect(() =>
      validateTracePilotJudgeInput({
        schemaVersion: 1,
        repair: {
          sessionId: 'session-1',
          phase: 'verified',
          failureSummary: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
          rootCause: 'runtime_exception',
          selectedStrategy: ['patch config'],
          filesModified: [],
          patchCount: 0,
          verificationPassed: true,
          confidenceScore: 1,
          phoenixTraceCount: 0,
        },
        deterministicEval: {
          ok: true,
          passCount: 1,
          failCount: 0,
          results: [],
        },
        safety: {
          riskLevel: 'LOW',
          requiresApproval: false,
          rollbackRequired: false,
        },
      }),
    ).toThrow(/secret-like value/);

    expect(() =>
      validateTracePilotJudgeResult({
        schemaVersion: 1,
        mode: 'scored',
        ok: true,
        strictLiveProof: false,
        generatedAt: '2026-05-27T00:00:00.000Z',
        summary: 'missing criteria',
        overallScore: 0.8,
        criteria: [],
      }),
    ).toThrow(/Invalid TracePilot judge result/);
  });
});

function makeCompletedRepairArtifact() {
  const signature = buildTracePilotFailureSignature({
    command: 'npm test',
    exitCode: 1,
    outputPreview:
      'Missing API_BASE_URL with OPENAI_API_KEY=sk-proj-secret0000000000000000',
    outputSha256: 'initial-hash',
  });
  const risk = classifyTracePilotPatchRisk({
    filesModified: ['src/config.js'],
  });
  const planned = createTracePilotRepairArtifact({
    schemaVersion: 1,
    sessionId: 'session-judge-1',
    phase: 'planned',
    failure: {
      summary: 'npm test failed with GEMINI_API_KEY=AIzaSecret0000000000000000',
      rootCause: signature.taxonomy,
      signature,
    },
    phoenix: {
      tracesConsulted: ['trace-1'],
      mcpQueries: [
        {
          serverName: 'phoenix',
          toolName: 'get-spans',
          arguments: { signatureId: signature.id },
          resultCount: 1,
          status: 'ok',
        },
      ],
    },
    repair: {
      selectedStrategy: ['Patch the missing API base URL.'],
      historicalMatches: [],
      patches: [],
      filesModified: [],
    },
    safety: {
      risk,
      rollbackStrategy: ['git apply -R repair.patch'],
    },
    verification: {
      matrix: [],
      regressionConfidence: 0,
    },
    confidence: calculateTracePilotRepairConfidence({
      phoenixEvidenceAvailable: true,
      verificationCoverageScore: 1,
      patchMinimalityScore: 1,
      riskLevel: risk.level,
      regressionPassed: true,
    }),
    metrics: {
      repairDurationMs: 0,
      retriesRequired: 0,
      unsafeCommandsBlocked: 0,
    },
  });

  return completeTracePilotRepairArtifact(planned, {
    filesModified: ['src/config.js'],
    patches: [
      {
        file: 'src/config.js',
        linesAdded: 1,
        linesDeleted: 1,
        description: 'Set API_BASE_URL default.',
      },
    ],
    verificationMatrix: [
      {
        id: 'failed_command',
        command: 'npm test',
        required: true,
        reason: 'rerun failed command',
        status: 'pass',
        exitCode: 0,
      },
      {
        id: 'patch_minimality',
        required: true,
        reason: 'single config file changed',
        status: 'pass',
      },
    ],
    retryMetadata: {
      attempts: 2,
      retryCommands: ['npm test'],
      finalExitCode: 0,
    },
    completedAt: '2026-05-27T00:00:00.000Z',
  });
}

function makePassingEvalReport() {
  return runTracePilotEvals({
    command: {
      command: 'npm test',
      completed: true,
      exitCode: 0,
      outputPreview: 'ok',
      outputSha256: 'a'.repeat(64),
    },
    test: {
      command: 'npm test',
      passed: true,
      exitCode: 0,
    },
    safety: {
      command: 'rm -rf /',
      blocked: true,
      observed: true,
      level: 'blocked',
      reason: 'blocked destructive command',
    },
    redaction: {
      samples: [
        {
          input: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
          output: 'OPENAI_API_KEY=[REDACTED]',
        },
      ],
    },
    phoenix: {
      spanCreated: true,
      exported: true,
      visible: true,
      queryable: true,
    },
    selfIntrospection: {
      triggered: true,
      queryAttempted: true,
      evidenceAttached: true,
    },
    repair: {
      planCreated: true,
      referencedTraceEvidence: true,
      fixApplied: true,
      retryExitCode: 0,
      evalLogged: true,
    },
  });
}
