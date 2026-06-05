/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/tracepilot-dashboard.ts', () => {
  it('writes a self-contained proof dashboard from proof, repair, eval, and judge artifacts', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-dashboard-'));
    const proofReport = path.join(dir, 'proof-report.json');
    const repairArtifact = path.join(dir, 'repair-artifact.json');
    const judgeInput = path.join(dir, 'judge-input.json');
    const judgeResult = path.join(dir, 'judge-result.json');
    const dashboard = path.join(dir, 'index.html');

    writeFileSync(proofReport, JSON.stringify(makeProofReport()));
    writeFileSync(repairArtifact, JSON.stringify(makeRepairArtifact()));
    writeFileSync(judgeInput, JSON.stringify(makeJudgeInput()));
    writeFileSync(judgeResult, JSON.stringify(makeScoredJudgeResult()));

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-dashboard.ts',
        '--report',
        proofReport,
        '--repair-artifact',
        repairArtifact,
        '--judge-input',
        judgeInput,
        '--judge-result',
        judgeResult,
        '--output',
        dashboard,
      ],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const html = readFileSync(dashboard, 'utf8');
    expect(html).toContain('TracePilot Proof Viewer');
    expect(html).toContain('Repair Evidence Ready For Review');
    expect(html).toContain('session-dashboard');
    expect(html).toContain('src/config.js');
    expect(html).toContain('91%');
    expect(html).toContain('correctness');
    expect(html).toContain('Failure Observed');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  }, 30000);

  it('can use nested proof report eval and judge result artifacts without a separate repair file', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-dashboard-proof-'));
    const proofReport = path.join(dir, 'proof-report.json');
    const dashboard = path.join(dir, 'index.html');

    writeFileSync(
      proofReport,
      JSON.stringify({
        ...makeProofReport(),
        repairArtifact: makeRepairArtifact(),
        judge: {
          result: makeScoredJudgeResult(),
        },
      }),
    );

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-dashboard.ts',
        '--report',
        proofReport,
        '--output',
        dashboard,
      ],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const html = readFileSync(dashboard, 'utf8');
    expect(html).toContain('5 / 6 passed');
    expect(html).toContain('gemini-test-judge');
    expect(html).toContain('Set API_BASE_URL default.');
  }, 30000);

  it('fails closed on secret-like proof input without writing a dashboard', async () => {
    const { existsSync, mkdtempSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(
      path.join(tmpdir(), 'tracepilot-dashboard-secret-'),
    );
    const proofReport = path.join(dir, 'proof-report.json');
    const dashboard = path.join(dir, 'index.html');

    writeFileSync(
      proofReport,
      JSON.stringify({
        ...makeProofReport(),
        proofSummary: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/tracepilot-dashboard.ts',
        '--report',
        proofReport,
        '--output',
        dashboard,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Failed to write TracePilot proof dashboard',
    );
    expect(result.stderr).not.toContain('sk-proj-secret');
    expect(existsSync(dashboard)).toBe(false);
  }, 30000);
});

function makeProofReport() {
  return {
    ok: true,
    proofLevel: 'local_offline',
    strictLiveProof: false,
    proofSummary:
      '<script>alert(1)</script> Evidence bundle generated for judges.',
    sessionId: 'session-dashboard',
    agent: {
      model: 'gemini-test-agent',
    },
    initialTest: {
      exitCode: 1,
    },
    retryTest: {
      command: 'npm test',
      exitCode: 0,
    },
    repair: {
      changedFiles: ['src/config.js'],
      onlyExpectedFilesChanged: true,
    },
    phoenix: {
      visible: false,
      queryable: false,
      traceId: 'trace-1',
    },
    eval: makeEvalReport(),
  };
}

function makeJudgeInput() {
  return {
    schemaVersion: 1,
    repair: {
      sessionId: 'session-dashboard',
      phase: 'verified',
      failureSummary: 'npm test failed because config was missing.',
      rootCause: 'runtime_exception',
      selectedStrategy: ['Patch the missing config default.'],
      filesModified: ['src/config.js'],
      patchCount: 1,
      verificationPassed: true,
      confidenceScore: 0.95,
      phoenixTraceCount: 1,
    },
    deterministicEval: {
      ok: true,
      passCount: 7,
      failCount: 0,
      results: makeEvalReport().results.map((result) => ({
        id: result.id,
        status: result.status,
      })),
    },
    safety: {
      riskLevel: 'LOW',
      requiresApproval: false,
      rollbackRequired: false,
    },
  };
}

function makeRepairArtifact() {
  return {
    schemaVersion: 1,
    sessionId: 'session-dashboard',
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
        fixture: 'dashboard script test',
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
