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
});
