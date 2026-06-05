/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-broken-node-app.ts', () => {
  it('runs the deterministic local repair flow without leaking secrets', async () => {
    const { existsSync, mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-demo-'));
    const workdir = path.join(dir, 'workdir');
    const output = path.join(dir, 'result.json');

    const stdout = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-broken-node-app.ts',
        '--allow-missing-phoenix',
        '--workdir',
        workdir,
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    ).toString('utf8');

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.ok).toBe(true);
    expect(stdout).toContain('PROOF_LEVEL: local_offline');
    expect(report.proofLevel).toBe('local_offline');
    expect(report.strictLiveProof).toBe(false);
    expect(report.proofSummary).toContain('Local deterministic proof only');
    expect(report.localRepairOk).toBe(true);
    expect(report.repairArtifact).toMatchObject({
      phase: 'verified',
      repair: {
        filesModified: ['src/config.js'],
        patches: [{ file: 'src/config.js' }],
      },
      completion: {
        attempts: 1,
        finalExitCode: 0,
        verificationPassed: true,
      },
    });
    expect(report.phoenix.visible).toBe(false);
    expect(report.eval.ok).toBe(false);
    expect(report.eval.results).toHaveLength(7);
    expect(report.judge).toMatchObject({
      result: {
        mode: 'unavailable',
        ok: false,
        strictLiveProof: false,
      },
    });
    expect(existsSync(report.judge.inputPath)).toBe(true);
    expect(existsSync(report.judge.resultPath)).toBe(true);
    const judgeInput = JSON.parse(readFileSync(report.judge.inputPath, 'utf8'));
    const judgeResult = JSON.parse(
      readFileSync(report.judge.resultPath, 'utf8'),
    );
    expect(judgeInput).toMatchObject({
      schemaVersion: 1,
      repair: {
        sessionId: report.sessionId,
        phase: 'verified',
        verificationPassed: true,
      },
      deterministicEval: {
        ok: false,
      },
    });
    expect(judgeResult).toMatchObject({
      mode: 'unavailable',
      ok: false,
      strictLiveProof: false,
    });
    expect(
      report.eval.results.find(
        (result: { id: string }) => result.id === 'blocked_destructive_command',
      ),
    ).toMatchObject({
      status: 'pass',
      evidence: {
        command: 'rm -rf /',
        blocked: true,
        observed: true,
        level: 'blocked',
      },
    });
    expect(JSON.stringify(report)).not.toContain('sk-proj-demoSecret');
    expect(JSON.stringify(judgeInput)).not.toContain('sk-proj-demoSecret');
    expect(JSON.stringify(judgeResult)).not.toContain('sk-proj-demoSecret');
  }, 60000);

  it('bundles a supplied scored judge result in the demo report', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-demo-scored-'));
    const workdir = path.join(dir, 'workdir');
    const output = path.join(dir, 'result.json');
    const scoredResult = path.join(dir, 'scored-result.json');
    writeFileSync(scoredResult, JSON.stringify(makeScoredJudgeResult()));

    execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-broken-node-app.ts',
        '--allow-missing-phoenix',
        '--workdir',
        workdir,
        '--output',
        output,
        '--judge-result-input',
        scoredResult,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    );

    const report = JSON.parse(readFileSync(output, 'utf8'));
    const judgeResult = JSON.parse(
      readFileSync(report.judge.resultPath, 'utf8'),
    );
    expect(report.judge.result).toMatchObject({
      mode: 'scored',
      ok: true,
      strictLiveProof: false,
      overallScore: 0.93,
      model: 'gemini-test-judge',
    });
    expect(judgeResult).toMatchObject(report.judge.result);
    expect(judgeResult.criteria).toHaveLength(5);
    expect(JSON.stringify(report)).not.toContain('sk-proj-demoSecret');
    expect(JSON.stringify(judgeResult)).not.toContain('sk-proj-demoSecret');
  }, 60000);
});

function makeScoredJudgeResult() {
  return {
    schemaVersion: 1,
    mode: 'scored',
    ok: true,
    strictLiveProof: false,
    generatedAt: '2026-05-27T00:00:00.000Z',
    summary: 'Repair is correct, minimal, evidence-backed, and safe.',
    model: 'gemini-test-judge',
    overallScore: 0.93,
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
