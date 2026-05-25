/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTracePilotFailureSignature } from './failureSignature.js';
import { calculateTracePilotRepairConfidence } from './repairConfidence.js';
import {
  completeTracePilotRepairArtifact,
  createTracePilotRepairArtifact,
  renderTracePilotRepairMarkdown,
  stableTracePilotRepairArtifactJson,
} from './repairReport.js';
import { classifyTracePilotPatchRisk } from './repairRisk.js';
import type { TracePilotVerificationResult } from './verificationMatrix.js';

describe('TracePilot repair reports', () => {
  it('renders planning-only artifacts without applied patch claims', () => {
    const artifact = makePlannedArtifact();
    const markdown = renderTracePilotRepairMarkdown(artifact);

    expect(artifact.phase).toBe('planned');
    expect(markdown).toContain('Phase: planned');
    expect(markdown).toContain('Files modified: none');
    expect(markdown).toContain('Not completed yet.');
  });

  it('updates completed artifacts with patches, verification, and retry metadata', () => {
    const verification: TracePilotVerificationResult[] = [
      {
        id: 'failed_command',
        command: 'npm test',
        required: true,
        reason: 'prove original failure is repaired',
        status: 'pass',
        exitCode: 0,
        outputSha256: 'retry-hash',
      },
      {
        id: 'patch_minimality',
        required: true,
        reason: 'confirm only the target file changed',
        status: 'pass',
      },
    ];
    const completed = completeTracePilotRepairArtifact(makePlannedArtifact(), {
      filesModified: ['src/config.js'],
      patches: [
        {
          file: 'src/config.js',
          linesAdded: 1,
          linesDeleted: 1,
          description: 'Set API base URL',
        },
      ],
      verificationMatrix: verification,
      retryMetadata: {
        attempts: 2,
        retryCommands: ['npm test'],
        finalExitCode: 0,
      },
      completedAt: '2026-05-26T00:00:00.000Z',
      repairDurationMs: 1234,
      rollbackStrategy: ['git apply -R repair.patch'],
    });
    const markdown = renderTracePilotRepairMarkdown(completed);
    const json = stableTracePilotRepairArtifactJson(completed);

    expect(completed).toMatchObject({
      phase: 'verified',
      repair: {
        filesModified: ['src/config.js'],
        patches: [{ file: 'src/config.js' }],
      },
      completion: {
        attempts: 2,
        finalExitCode: 0,
        verificationPassed: true,
      },
      metrics: {
        retriesRequired: 1,
        repairDurationMs: 1234,
      },
    });
    expect(completed.verification.regressionConfidence).toBe(1);
    expect(markdown).toContain('Phase: verified');
    expect(markdown).toContain('src/config.js');
    expect(markdown).toContain('verification_passed=true');
    expect(json).not.toContain('sk-proj-secret');
  });
});

function makePlannedArtifact() {
  const signature = buildTracePilotFailureSignature({
    command: 'npm test',
    exitCode: 1,
    outputPreview: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
    outputSha256: 'initial-hash',
  });
  const risk = classifyTracePilotPatchRisk({ filesModified: [] });
  return createTracePilotRepairArtifact({
    schemaVersion: 1,
    sessionId: 'session-1',
    phase: 'planned',
    failure: {
      summary: 'npm test failed',
      rootCause: signature.taxonomy,
      signature,
    },
    phoenix: {
      tracesConsulted: [],
      mcpQueries: [],
    },
    repair: {
      selectedStrategy: ['Patch the smallest failing source path.'],
      historicalMatches: [],
      patches: [],
      filesModified: [],
    },
    safety: {
      risk,
      rollbackStrategy: ['No patch has been applied yet.'],
    },
    verification: {
      matrix: [],
      regressionConfidence: 0,
    },
    confidence: calculateTracePilotRepairConfidence({
      phoenixEvidenceAvailable: false,
      verificationCoverageScore: 0,
      patchMinimalityScore: 1,
      riskLevel: risk.level,
      regressionPassed: false,
    }),
    metrics: {
      repairDurationMs: 0,
      retriesRequired: 0,
      unsafeCommandsBlocked: 0,
    },
  });
}
