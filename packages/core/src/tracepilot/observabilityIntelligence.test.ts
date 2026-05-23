/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildTracePilotFailureSignature,
  type TracePilotFailureSignature,
} from './failureSignature.js';
import { calculateTracePilotRepairConfidence } from './repairConfidence.js';
import {
  createTracePilotRepairFingerprint,
  rankTracePilotHistoricalRepairs,
  type TracePilotHistoricalRepairSession,
} from './repairMemory.js';
import {
  createTracePilotRepairArtifact,
  renderTracePilotRepairMarkdown,
  stableTracePilotRepairArtifactJson,
} from './repairReport.js';
import { classifyTracePilotPatchRisk } from './repairRisk.js';
import { buildTracePilotTerminalModel } from './terminalModel.js';
import {
  buildTracePilotVerificationMatrix,
  calculateTracePilotRegressionConfidence,
  type TracePilotVerificationResult,
} from './verificationMatrix.js';

describe('TracePilot observability intelligence primitives', () => {
  it('generates deterministic redacted failure signatures', () => {
    const first = buildTracePilotFailureSignature({
      command: 'npm run lint',
      exitCode: 1,
      outputPreview:
        'Error: typescript-eslint parser requires TypeScript 5.8\nOPENAI_API_KEY=sk-proj-secret0000000000000000\npackages/core/src/foo.ts:12:4',
      dependencies: {
        typescript: '5.9.0',
        '@typescript-eslint/parser': '8.30.1',
      },
    });
    const second = buildTracePilotFailureSignature({
      dependencies: {
        '@typescript-eslint/parser': '8.30.1',
        typescript: '5.9.0',
      },
      outputPreview:
        'Error: typescript-eslint parser requires TypeScript 5.8\nOPENAI_API_KEY=sk-proj-secret0000000000000000\npackages/core/src/foo.ts:12:4',
      exitCode: 1,
      command: 'npm run lint',
    });

    expect(first.id).toBe(second.id);
    expect(first.taxonomy).toBe('typescript_incompatibility');
    expect(JSON.stringify(first)).not.toContain('sk-proj-secret');
  });

  it('ranks historical repairs by deterministic similarity and verified outcomes', () => {
    const current = makeSignature('npm run lint', [
      'error: typescript-eslint parser requires typescript 5.8',
    ]);
    const verifiedMatch = makeHistoricalSession({
      sessionId: 'session-a',
      command: 'npm run lint',
      diagnostics: ['error: typescript-eslint parser requires typescript 5.8'],
      outcome: 'verified',
    });
    const failedMatch = makeHistoricalSession({
      sessionId: 'session-b',
      command: 'npm run lint',
      diagnostics: ['error: typescript-eslint parser requires typescript 5.8'],
      outcome: 'failed',
    });
    const unrelated = makeHistoricalSession({
      sessionId: 'session-c',
      command: 'npm test',
      diagnostics: ['assertionerror: expected api base url'],
      outcome: 'verified',
    });

    const ranked = rankTracePilotHistoricalRepairs(current, [
      unrelated,
      failedMatch,
      verifiedMatch,
    ]);

    expect(ranked.map((candidate) => candidate.session.sessionId)).toEqual([
      'session-a',
      'session-c',
      'session-b',
    ]);
    expect(ranked[0].matchedReasons).toContain('diagnostics');
    expect(ranked[0].historicalOutcomeScore).toBe(1);
  });

  it('calculates confidence with Phoenix, verification, minimality, and risk caps', () => {
    const current = makeSignature('npm run lint', ['error: parser failed']);
    const [candidate] = rankTracePilotHistoricalRepairs(current, [
      makeHistoricalSession({
        sessionId: 'session-a',
        command: 'npm run lint',
        diagnostics: ['error: parser failed'],
        outcome: 'verified',
      }),
    ]);
    const confidence = calculateTracePilotRepairConfidence({
      topCandidate: candidate,
      phoenixEvidenceAvailable: true,
      verificationCoverageScore: 1,
      patchMinimalityScore: 0.9,
      riskLevel: 'LOW',
      regressionPassed: true,
    });
    const capped = calculateTracePilotRepairConfidence({
      topCandidate: candidate,
      phoenixEvidenceAvailable: false,
      verificationCoverageScore: 1,
      patchMinimalityScore: 1,
      riskLevel: 'LOW',
      regressionPassed: true,
    });

    expect(confidence.score).toBeGreaterThan(0.8);
    expect(capped.score).toBeLessThanOrEqual(0.62);
    expect(capped.cappedBy).toContain('missing_phoenix_evidence');
  });

  it('classifies patch risk and builds regression-aware verification matrices', () => {
    const risk = classifyTracePilotPatchRisk({
      filesModified: ['packages/core/src/policy/config.ts'],
      linesAdded: 12,
      linesDeleted: 4,
    });
    const matrix = buildTracePilotVerificationMatrix({
      failedCommand: 'npm run lint',
      filesModified: ['package.json', 'packages/core/src/index.ts'],
      packageFilesModified: true,
      sharedModulesModified: true,
    });
    const results: TracePilotVerificationResult[] = matrix.map((check) => ({
      ...check,
      status: 'pass',
      exitCode: check.command ? 0 : undefined,
    }));

    expect(risk.level).toBe('HIGH');
    expect(risk.requiresApproval).toBe(true);
    expect(matrix.map((check) => check.id)).toContain('dependency_integrity');
    expect(matrix.find((check) => check.id === 'tests')?.command).toBe(
      'npm test',
    );
    expect(calculateTracePilotRegressionConfidence(results)).toBe(1);
  });

  it('renders deterministic repair artifacts, markdown reports, and terminal model data', () => {
    const signature = makeSignature('npm run lint', [
      'error: typescript parser failed',
    ]);
    const fingerprint = createTracePilotRepairFingerprint({
      strategy: ['Pin parser and TypeScript versions'],
      filesModified: ['package.json'],
      dependencyChanges: { typescript: '5.8.3' },
      verificationCommands: ['npm run lint'],
    });
    const [candidate] = rankTracePilotHistoricalRepairs(signature, [
      makeHistoricalSession({
        sessionId: 'session-a',
        command: 'npm run lint',
        diagnostics: ['error: typescript parser failed'],
        outcome: 'verified',
      }),
    ]);
    const risk = classifyTracePilotPatchRisk({
      filesModified: ['package.json'],
      dependencyChanges: 1,
      linesAdded: 1,
      linesDeleted: 1,
    });
    const verification: TracePilotVerificationResult[] =
      buildTracePilotVerificationMatrix({
        failedCommand: 'npm run lint',
        filesModified: ['package.json'],
        packageFilesModified: true,
      }).map((check) => ({ ...check, status: 'pass', exitCode: 0 }));
    const artifact = createTracePilotRepairArtifact({
      schemaVersion: 1,
      sessionId: 'session-current',
      failure: {
        summary: 'typescript parser failure',
        rootCause: 'typescript parser incompatibility',
        signature,
      },
      phoenix: {
        tracesConsulted: ['trace-1'],
        mcpQueries: [
          {
            serverName: 'phoenix',
            toolName: 'get-spans',
            arguments: {
              query: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
            },
            resultCount: 3,
            status: 'ok',
          },
        ],
      },
      repair: {
        selectedStrategy: ['Pin parser and TypeScript versions'],
        historicalMatches: [
          {
            sessionId: candidate.session.sessionId,
            traceId: candidate.session.traceId,
            similarityScore: candidate.similarityScore,
            historicalOutcomeScore: candidate.historicalOutcomeScore,
            matchedReasons: candidate.matchedReasons,
          },
        ],
        patches: [
          {
            file: 'package.json',
            linesAdded: 1,
            linesDeleted: 1,
            description: `fingerprint ${fingerprint}`,
          },
        ],
        filesModified: ['package.json'],
      },
      safety: {
        risk,
        rollbackStrategy: ['git apply -R repair.patch'],
      },
      verification: {
        matrix: verification,
        regressionConfidence:
          calculateTracePilotRegressionConfidence(verification),
      },
      confidence: calculateTracePilotRepairConfidence({
        topCandidate: candidate,
        phoenixEvidenceAvailable: true,
        verificationCoverageScore: 1,
        patchMinimalityScore: 1,
        riskLevel: risk.level,
        regressionPassed: true,
      }),
      metrics: {
        repairDurationMs: 1200,
        retriesRequired: 1,
        unsafeCommandsBlocked: 0,
      },
    });

    const json = stableTracePilotRepairArtifactJson(artifact);
    const markdown = renderTracePilotRepairMarkdown(artifact);
    const model = buildTracePilotTerminalModel(artifact);

    expect(json).toBe(stableTracePilotRepairArtifactJson(artifact));
    expect(json).not.toContain('sk-proj-secret');
    expect(markdown).toContain('TracePilot Repair Report');
    expect(markdown).toContain('Confidence:');
    expect(model.timeline.map((item) => item.label)).toContain(
      '1 historical repairs found',
    );
    expect(model.evidence.riskLevel).toBe('LOW');
  });
});

function makeSignature(
  command: string,
  diagnostics: string[],
): TracePilotFailureSignature {
  return buildTracePilotFailureSignature({
    command,
    exitCode: 1,
    diagnostics,
    files: ['packages/core/src/tracepilot/repairPlanner.ts'],
    dependencies: {
      typescript: '5.8.3',
      '@typescript-eslint/parser': '8.30.1',
    },
  });
}

function makeHistoricalSession(input: {
  sessionId: string;
  command: string;
  diagnostics: string[];
  outcome: TracePilotHistoricalRepairSession['outcome'];
}): TracePilotHistoricalRepairSession {
  const signature = makeSignature(input.command, input.diagnostics);
  return {
    sessionId: input.sessionId,
    traceId: `trace-${input.sessionId}`,
    signature,
    repairFingerprint: createTracePilotRepairFingerprint({
      strategy: ['pin compatible parser and typescript versions'],
      filesModified: ['package.json'],
      dependencyChanges: { typescript: '5.8.3' },
      verificationCommands: [input.command],
    }),
    rootCause: signature.taxonomy,
    strategy: ['pin compatible parser and typescript versions'],
    outcome: input.outcome,
    attempts: 1,
    verificationPassed: input.outcome === 'verified',
    regressionPassed: input.outcome === 'verified',
    tracesConsulted: [
      {
        spanName: 'gemini_cli.tool.shell',
        toolName: 'run_shell_command',
        exitCode: 1,
        outputSha256: 'a'.repeat(64),
      },
    ],
  };
}
