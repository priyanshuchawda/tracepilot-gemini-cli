/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildCompletedTracePilotRepairArtifact } from './completedRepairArtifact.js';

describe('buildCompletedTracePilotRepairArtifact', () => {
  it('creates a sanitized verified repair artifact from command and patch evidence', () => {
    const artifact = buildCompletedTracePilotRepairArtifact({
      sessionId: 'session-completed-builder',
      failedCommand: {
        command: 'node --test',
        exitCode: 1,
        output:
          'Missing API_BASE_URL with OPENAI_API_KEY=sk-proj-secret0000000000000000',
      },
      retryCommand: {
        command: 'node --test',
        exitCode: 0,
        output: 'ok',
      },
      filesModified: ['src/config.js'],
      patches: [
        {
          file: 'src/config.js',
          linesAdded: 1,
          linesDeleted: 1,
          description: 'Set API_BASE_URL default.',
        },
      ],
      selectedStrategy: ['Set API_BASE_URL default.', 'Rerun node --test.'],
      rollbackStrategy: ['Restore src/config.js.'],
      verificationMatrix: [
        {
          id: 'failed_command',
          command: 'node --test',
          required: true,
          reason: 'prove retry passes',
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
      phoenixEvidenceAvailable: true,
      phoenixTracesConsulted: ['trace-1'],
      phoenixMcpQueries: [
        {
          serverName: 'phoenix',
          toolName: 'get-spans',
          arguments: { sessionId: 'session-completed-builder' },
          resultCount: 1,
          status: 'ok',
        },
      ],
      repairDurationMs: 42,
      completedAt: '2026-05-27T00:00:00.000Z',
      failureSummary:
        'Fixture test failed in node --test with OPENAI_API_KEY=sk-proj-secret0000000000000000',
    });

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      sessionId: 'session-completed-builder',
      phase: 'verified',
      failure: {
        summary: expect.stringContaining('[REDACTED]'),
      },
      phoenix: {
        tracesConsulted: ['trace-1'],
        mcpQueries: [{ status: 'ok', resultCount: 1 }],
      },
      repair: {
        filesModified: ['src/config.js'],
        patches: [{ file: 'src/config.js', linesAdded: 1, linesDeleted: 1 }],
      },
      completion: {
        attempts: 1,
        retryCommands: ['node --test'],
        finalExitCode: 0,
        verificationPassed: true,
      },
    });
    expect(JSON.stringify(artifact)).not.toContain('sk-proj-secret');
    expect(JSON.stringify(artifact)).toContain('[REDACTED]');
  });

  it('allows callers to preserve degraded confidence scoring semantics', () => {
    const artifact = buildCompletedTracePilotRepairArtifact({
      sessionId: 'session-degraded-builder',
      failedCommand: {
        command: 'node --test',
        exitCode: 1,
        output: 'checkout service tests failed',
      },
      retryCommand: {
        command: 'node --test',
        exitCode: 0,
        output: 'ok',
      },
      filesModified: ['src/config.js'],
      patches: [
        {
          file: 'src/config.js',
          linesAdded: 1,
          linesDeleted: 1,
          description: 'Patch config.',
        },
      ],
      selectedStrategy: ['Patch config.', 'Rerun tests.'],
      rollbackStrategy: ['Restore fixture files.'],
      verificationMatrix: [
        {
          id: 'failed_command',
          command: 'node --test',
          required: true,
          reason: 'prove retry passes',
          status: 'pass',
          exitCode: 0,
        },
        {
          id: 'regression_scope',
          required: true,
          reason: 'live Phoenix evidence was unavailable',
          status: 'skipped',
        },
      ],
      phoenixEvidenceAvailable: false,
      phoenixTracesConsulted: [],
      phoenixMcpQueries: [
        {
          serverName: 'phoenix',
          toolName: 'get-spans',
          arguments: { sessionId: 'session-degraded-builder' },
          resultCount: 0,
          status: 'skipped',
          reason: 'Phoenix env missing.',
        },
      ],
      confidence: {
        verificationCoverageScore: 0.5,
        patchMinimalityScore: 0.5,
        regressionPassed: false,
      },
    });

    expect(artifact.phase).toBe('applied');
    expect(artifact.confidence.components).toMatchObject({
      verificationCoverage: 0.5,
      patchMinimality: 0.5,
    });
    expect(artifact.confidence.cappedBy).toEqual([
      'missing_phoenix_evidence',
      'regression_not_verified',
    ]);
  });

  it('preserves dependency signatures and multi-command completion metadata', () => {
    const artifact = buildCompletedTracePilotRepairArtifact({
      sessionId: 'session-matrix-builder',
      failedCommand: {
        command: 'tracepilot verification matrix',
        exitCode: 0,
        output: 'TracePilot verification matrix passed.',
      },
      retryCommand: {
        command: 'tracepilot verification matrix',
        exitCode: 0,
        output: 'ok',
      },
      filesModified: [],
      patches: [],
      selectedStrategy: [
        'No repair required; persist successful verification evidence.',
      ],
      rollbackStrategy: ['No patch applied.'],
      verificationMatrix: [
        {
          id: 'typecheck',
          command: 'node tsc --noEmit',
          required: true,
          reason: 'verify TypeScript stability',
          status: 'pass',
          exitCode: 0,
        },
        {
          id: 'tests',
          command: 'node vitest run',
          required: true,
          reason: 'verify regression tests',
          status: 'pass',
          exitCode: 0,
        },
      ],
      phoenixEvidenceAvailable: true,
      phoenixTracesConsulted: [],
      phoenixMcpQueries: (signature) => [
        {
          serverName: 'phoenix',
          toolName: 'get-spans',
          arguments: {
            mode: 'local-verification-artifact',
            signatureId: signature.id,
          },
          resultCount: 0,
          status: 'ok',
        },
      ],
      failureSignatureDependencies: {
        typescript: '^5.0.0',
        vitest: '^3.0.0',
      },
      completion: {
        attempts: 1,
        retryCommands: ['node tsc --noEmit', 'node vitest run'],
        finalExitCode: 0,
      },
    });

    expect(artifact.failure.signature.dependencies).toMatchObject({
      typescript: '^5.0.0',
      vitest: '^3.0.0',
    });
    expect(artifact.phoenix.mcpQueries[0]?.arguments).toMatchObject({
      signatureId: artifact.failure.signature.id,
    });
    expect(artifact.completion).toMatchObject({
      attempts: 1,
      retryCommands: ['node tsc --noEmit', 'node vitest run'],
      finalExitCode: 0,
      verificationPassed: true,
    });
  });
});
