/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-judge-evidence.ts', () => {
  it('writes judge input and a non-strict unavailable result when no scored result is supplied', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-judge-'));
    const repairArtifact = path.join(dir, 'repair.json');
    const evalReport = path.join(dir, 'eval-report.json');
    const judgeInput = path.join(dir, 'judge-input.json');
    const judgeResult = path.join(dir, 'judge-result.json');
    writeFileSync(repairArtifact, JSON.stringify(makeRepairArtifact()));
    writeFileSync(evalReport, JSON.stringify(makeEvalReport()));

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-judge-evidence.ts',
        '--repair-artifact',
        repairArtifact,
        '--eval-report',
        evalReport,
        '--judge-input-output',
        judgeInput,
        '--judge-result-output',
        judgeResult,
        '--unavailable-reason',
        'Gemini judge was not configured for this run.',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('JUDGE_MODE: unavailable');
    expect(result.stdout).toContain('strictLiveProof=false');

    const input = JSON.parse(readFileSync(judgeInput, 'utf8'));
    expect(input).toMatchObject({
      schemaVersion: 1,
      repair: {
        sessionId: 'session-judge-cli',
        phase: 'verified',
        patchCount: 1,
        verificationPassed: true,
        phoenixTraceCount: 1,
      },
      deterministicEval: {
        ok: true,
        passCount: 7,
        failCount: 0,
      },
      safety: {
        riskLevel: 'LOW',
        requiresApproval: false,
        rollbackRequired: false,
      },
    });

    const fallback = JSON.parse(readFileSync(judgeResult, 'utf8'));
    expect(fallback).toMatchObject({
      schemaVersion: 1,
      mode: 'unavailable',
      ok: false,
      strictLiveProof: false,
      summary: 'Repair-quality judge evidence unavailable.',
      unavailableReason: 'Gemini judge was not configured for this run.',
    });
  }, 30000);

  it('validates and emits a supplied scored judge result', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-judge-scored-'));
    const repairArtifact = path.join(dir, 'repair.json');
    const evalReport = path.join(dir, 'eval-report.json');
    const scoredResult = path.join(dir, 'scored-result.json');
    const judgeInput = path.join(dir, 'judge-input.json');
    const judgeResult = path.join(dir, 'judge-result.json');
    writeFileSync(repairArtifact, JSON.stringify(makeRepairArtifact()));
    writeFileSync(evalReport, JSON.stringify(makeEvalReport()));
    writeFileSync(scoredResult, JSON.stringify(makeScoredJudgeResult()));

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-judge-evidence.ts',
        '--repair-artifact',
        repairArtifact,
        '--eval-report',
        evalReport,
        '--judge-input-output',
        judgeInput,
        '--judge-result-input',
        scoredResult,
        '--judge-result-output',
        judgeResult,
      ],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const output = JSON.parse(readFileSync(judgeResult, 'utf8'));
    expect(output).toMatchObject({
      mode: 'scored',
      ok: true,
      strictLiveProof: false,
      overallScore: 0.91,
      model: 'gemini-test-judge',
    });
    expect(output.criteria).toHaveLength(5);
  }, 30000);

  it('fails closed on secret-like input without writing judge artifacts', async () => {
    const { existsSync, mkdtempSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-judge-secret-'));
    const repairArtifact = path.join(dir, 'repair.json');
    const evalReport = path.join(dir, 'eval-report.json');
    const judgeInput = path.join(dir, 'judge-input.json');
    const judgeResult = path.join(dir, 'judge-result.json');
    writeFileSync(
      repairArtifact,
      JSON.stringify({
        ...makeRepairArtifact(),
        failure: {
          ...makeRepairArtifact().failure,
          summary: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
        },
      }),
    );
    writeFileSync(evalReport, JSON.stringify(makeEvalReport()));

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-judge-evidence.ts',
        '--repair-artifact',
        repairArtifact,
        '--eval-report',
        evalReport,
        '--judge-input-output',
        judgeInput,
        '--judge-result-output',
        judgeResult,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Failed to write TracePilot judge evidence',
    );
    expect(result.stderr).not.toContain('sk-proj-secret');
    expect(existsSync(judgeInput)).toBe(false);
    expect(existsSync(judgeResult)).toBe(false);
  }, 30000);
});

function makeRepairArtifact() {
  return {
    schemaVersion: 1,
    sessionId: 'session-judge-cli',
    phase: 'verified',
    failure: {
      summary: 'npm test failed because config was missing.',
      rootCause: 'runtime_exception',
      signature: {
        id: 'runtime-exception:npm-test:abc123',
        taxonomy: 'runtime_exception',
        commandFamily: 'npm',
        exitCode: 1,
        diagnostics: ['Missing API_BASE_URL'],
        stackFrames: [],
        files: ['src/config.js'],
        dependencies: {},
        outputSha256: 'a'.repeat(64),
        canonical: {
          commandFamily: 'npm',
          diagnostics: ['Missing API_BASE_URL'],
        },
      },
    },
    phoenix: {
      tracesConsulted: ['trace-1'],
      mcpQueries: [
        {
          serverName: 'phoenix',
          toolName: 'get-spans',
          arguments: { signatureId: 'runtime-exception:npm-test:abc123' },
          resultCount: 1,
          status: 'ok',
        },
      ],
    },
    repair: {
      selectedStrategy: ['Patch the missing config default.'],
      historicalMatches: [],
      patches: [
        {
          file: 'src/config.js',
          linesAdded: 1,
          linesDeleted: 1,
          description: 'Set API_BASE_URL default.',
        },
      ],
      filesModified: ['src/config.js'],
    },
    safety: {
      risk: {
        level: 'LOW',
        reasons: ['source-only config patch'],
        requiresApproval: false,
        rollbackRequired: false,
      },
      rollbackStrategy: ['git apply -R repair.patch'],
    },
    verification: {
      matrix: [
        {
          id: 'failed_command',
          command: 'npm test',
          required: true,
          reason: 'rerun failed command',
          status: 'pass',
          exitCode: 0,
        },
      ],
      regressionConfidence: 1,
    },
    confidence: {
      score: 0.95,
      cappedBy: [],
      components: {
        similarity: 1,
        historicalOutcome: 1,
        verificationCoverage: 1,
        patchMinimality: 1,
        risk: 1,
      },
    },
    metrics: {
      repairDurationMs: 10,
      retriesRequired: 1,
      unsafeCommandsBlocked: 0,
    },
    completion: {
      completedAt: '2026-05-27T00:00:00.000Z',
      attempts: 2,
      retryCommands: ['npm test'],
      finalExitCode: 0,
      verificationPassed: true,
    },
  };
}

function makeEvalReport() {
  return {
    ok: true,
    generatedAt: '2026-05-27T00:00:00.000Z',
    results: [
      'command_success',
      'test_passed',
      'blocked_destructive_command',
      'secret_redaction_success',
      'phoenix_trace_created',
      'self_introspection_triggered',
      'repair_attempt_successful',
    ].map((id) => ({
      id,
      status: 'pass',
      deterministic: true,
      evidence: {
        fixture: 'judge evidence script test',
      },
    })),
  };
}

function makeScoredJudgeResult() {
  return {
    schemaVersion: 1,
    mode: 'scored',
    ok: true,
    strictLiveProof: false,
    generatedAt: '2026-05-27T00:00:00.000Z',
    summary: 'Repair is correct, minimal, evidence-backed, and safe.',
    model: 'gemini-test-judge',
    overallScore: 0.91,
    criteria: [
      'correctness',
      'minimality',
      'evidence_use',
      'safety',
      'confidence',
    ].map((criterion) => ({
      id: criterion,
      score: 0.9,
      rationale: `${criterion} criterion passed`,
      evidence: ['deterministic fixture'],
    })),
  };
}
