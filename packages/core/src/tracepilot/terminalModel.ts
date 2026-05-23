/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TracePilotRepairArtifact } from './repairReport.js';

export type TracePilotTimelineStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed';

export interface TracePilotTimelineItem {
  label: string;
  status: TracePilotTimelineStatus;
}

export interface TracePilotTerminalModel {
  timeline: TracePilotTimelineItem[];
  evidence: {
    rootCause: string;
    tracesConsulted: string[];
    similarityScore: number;
    confidenceScore: number;
    riskLevel: string;
  };
  phoenixStatus: {
    otelExport: 'ok' | 'degraded';
    mcpConnection: 'connected' | 'unavailable';
    tracesConsulted: number;
    evaluationStatus: 'pass' | 'fail' | 'pending';
  };
  verification: Array<{
    id: string;
    status: TracePilotTimelineStatus | 'skipped';
  }>;
  finalSummary: {
    filesModified: string[];
    totalDurationMs: number;
    confidenceScore: number;
    traceIds: string[];
  };
}

export function buildTracePilotTerminalModel(
  artifact: TracePilotRepairArtifact,
): TracePilotTerminalModel {
  const topMatch = artifact.repair.historicalMatches[0];
  return {
    timeline: [
      { label: 'Verification started', status: 'passed' },
      { label: 'Failure signature generated', status: 'passed' },
      {
        label: 'Phoenix queried',
        status: artifact.phoenix.mcpQueries.some(
          (query) => query.status === 'ok',
        )
          ? 'passed'
          : 'failed',
      },
      {
        label: `${artifact.repair.historicalMatches.length} historical repairs found`,
        status:
          artifact.repair.historicalMatches.length > 0 ? 'passed' : 'failed',
      },
      { label: 'Repair strategy selected', status: 'passed' },
      {
        label: 'Patch applied',
        status: artifact.repair.patches.length > 0 ? 'passed' : 'pending',
      },
      {
        label: 'Verification matrix running',
        status: artifact.verification.matrix.every(
          (check) => check.status === 'pass',
        )
          ? 'passed'
          : 'running',
      },
    ],
    evidence: {
      rootCause: artifact.failure.rootCause,
      tracesConsulted: artifact.phoenix.tracesConsulted,
      similarityScore: topMatch?.similarityScore ?? 0,
      confidenceScore: artifact.confidence.score,
      riskLevel: artifact.safety.risk.level,
    },
    phoenixStatus: {
      otelExport:
        artifact.phoenix.tracesConsulted.length > 0 ? 'ok' : 'degraded',
      mcpConnection: artifact.phoenix.mcpQueries.some(
        (query) => query.status === 'ok',
      )
        ? 'connected'
        : 'unavailable',
      tracesConsulted: artifact.phoenix.tracesConsulted.length,
      evaluationStatus: artifact.verification.matrix.every(
        (check) => check.status === 'pass',
      )
        ? 'pass'
        : 'pending',
    },
    verification: artifact.verification.matrix.map((check) => ({
      id: check.id,
      status:
        check.status === 'pass'
          ? 'passed'
          : check.status === 'fail'
            ? 'failed'
            : 'skipped',
    })),
    finalSummary: {
      filesModified: artifact.repair.filesModified,
      totalDurationMs: artifact.metrics.repairDurationMs,
      confidenceScore: artifact.confidence.score,
      traceIds: artifact.phoenix.tracesConsulted,
    },
  };
}
