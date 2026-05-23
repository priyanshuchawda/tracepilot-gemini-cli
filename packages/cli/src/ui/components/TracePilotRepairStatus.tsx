/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';

export interface TracePilotRepairStatusModel {
  timeline: Array<{ label: string; status: string }>;
  evidence: {
    rootCause: string;
    tracesConsulted: string[];
    similarityScore: number;
    confidenceScore: number;
    riskLevel: string;
  };
  phoenixStatus: {
    otelExport: string;
    mcpConnection: string;
    tracesConsulted: number;
    evaluationStatus: string;
  };
  verification: Array<{ id: string; status: string }>;
  finalSummary: {
    filesModified: string[];
    totalDurationMs: number;
    confidenceScore: number;
    traceIds: string[];
  };
}

export interface TracePilotRepairStatusProps {
  model: TracePilotRepairStatusModel;
}

export const TracePilotRepairStatus: React.FC<TracePilotRepairStatusProps> = ({
  model,
}) => (
  <Box flexDirection="column" gap={1}>
    <Box flexDirection="column">
      <Text bold>TracePilot Repair Timeline</Text>
      {model.timeline.map((item) => (
        <Text key={item.label}>
          <Text color={statusColor(item.status)}>
            {statusMark(item.status)}
          </Text>{' '}
          {item.label}
        </Text>
      ))}
    </Box>

    <Box flexDirection="column">
      <Text bold>Evidence</Text>
      <Text>Root cause: {model.evidence.rootCause}</Text>
      <Text>
        Historical similarity: {formatPercent(model.evidence.similarityScore)}
      </Text>
      <Text>Confidence: {formatPercent(model.evidence.confidenceScore)}</Text>
      <Text>Risk: {model.evidence.riskLevel}</Text>
      <Text>
        Phoenix traces:{' '}
        {model.evidence.tracesConsulted.length > 0
          ? model.evidence.tracesConsulted.join(', ')
          : 'none'}
      </Text>
    </Box>

    <Box flexDirection="column">
      <Text bold>Phoenix Status</Text>
      <Text>OTEL export: {model.phoenixStatus.otelExport}</Text>
      <Text>MCP connection: {model.phoenixStatus.mcpConnection}</Text>
      <Text>Traces consulted: {model.phoenixStatus.tracesConsulted}</Text>
      <Text>Evaluation: {model.phoenixStatus.evaluationStatus}</Text>
    </Box>

    <Box flexDirection="column">
      <Text bold>Verification Matrix</Text>
      {model.verification.map((check) => (
        <Text key={check.id}>
          <Text color={statusColor(check.status)}>
            {statusMark(check.status)}
          </Text>{' '}
          {check.id}
        </Text>
      ))}
    </Box>

    <Box flexDirection="column">
      <Text bold>Final Summary</Text>
      <Text>
        Files modified:{' '}
        {model.finalSummary.filesModified.length > 0
          ? model.finalSummary.filesModified.join(', ')
          : 'none'}
      </Text>
      <Text>Duration: {Math.round(model.finalSummary.totalDurationMs)}ms</Text>
      <Text>
        Repair confidence: {formatPercent(model.finalSummary.confidenceScore)}
      </Text>
      <Text>
        Trace IDs:{' '}
        {model.finalSummary.traceIds.length > 0
          ? model.finalSummary.traceIds.join(', ')
          : 'none'}
      </Text>
    </Box>
  </Box>
);

function statusMark(status: string): string {
  switch (status) {
    case 'passed':
    case 'pass':
      return '[OK]';
    case 'failed':
    case 'fail':
      return '[FAIL]';
    case 'running':
      return '[RUN]';
    case 'skipped':
      return '[SKIP]';
    default:
      return '[WAIT]';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'passed':
    case 'pass':
      return theme.status.success;
    case 'failed':
    case 'fail':
      return theme.status.error;
    case 'running':
      return theme.status.warning;
    default:
      return theme.text.secondary;
  }
}

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
