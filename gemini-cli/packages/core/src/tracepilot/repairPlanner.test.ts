/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  CoreToolCallStatus,
  type ErroredToolCall,
} from '../scheduler/types.js';
import { GeminiCliOperation } from '../telemetry/constants.js';
import type { PhoenixSelfIntrospectionResult } from '../telemetry/phoenixSelfIntrospection.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { SHELL_TOOL_NAME } from '../tools/tool-names.js';
import { buildTraceEvidenceRepairPlan } from './repairPlanner.js';

const runInDevTraceSpan = vi.hoisted(() =>
  vi.fn(async (opts, fn) => {
    const metadata = { attributes: opts.attributes ?? {} };
    return fn({ metadata });
  }),
);

vi.mock('../telemetry/trace.js', () => ({
  runInDevTraceSpan,
}));

describe('TracePilot repair planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a repair plan from Phoenix trace evidence and emits a repair-plan span', async () => {
    const introspection: PhoenixSelfIntrospectionResult = {
      attempted: true,
      available: true,
      evidence: {
        spanName: 'gemini_cli.tool.shell',
        toolName: SHELL_TOOL_NAME,
        exitCode: 1,
        outputPreview: 'AssertionError: expected API_BASE_URL to be set',
        outputSha256: 'abc123',
      },
    };

    const plan = await buildTraceEvidenceRepairPlan(
      makeConfig(),
      makeFailedShellCall('npm test'),
      introspection,
    );

    expect(runInDevTraceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: GeminiCliOperation.RepairPlan,
        sessionId: 'session-1',
      }),
      expect.any(Function),
    );
    expect(plan).toMatchObject({
      created: true,
      source: 'phoenix_trace',
      failedToolName: SHELL_TOOL_NAME,
      failedCommand: 'npm test',
      commandRiskLevel: 'low',
      verificationCommand: 'npm test',
      referencedTraceEvidence: true,
      traceEvidenceAvailable: true,
      failureEvidence: {
        spanName: 'gemini_cli.tool.shell',
        toolName: SHELL_TOOL_NAME,
        exitCode: 1,
        outputPreview: 'AssertionError: expected API_BASE_URL to be set',
        outputSha256: 'abc123',
      },
    });
    expect(plan.proposedFix).toContain('trace evidence');
    expect(plan.text).toContain('TracePilot repair plan');
    expect(plan.text).toContain('output_sha256=abc123');
    expect(plan.text).toContain('failure_evidence=AssertionError');
  });

  it('degrades clearly when Phoenix trace evidence is unavailable', async () => {
    const introspection: PhoenixSelfIntrospectionResult = {
      attempted: true,
      available: false,
      reason: 'Phoenix MCP query timed out',
    };

    const plan = await buildTraceEvidenceRepairPlan(
      makeConfig(),
      makeFailedShellCall('npm test'),
      introspection,
    );

    expect(plan).toMatchObject({
      created: false,
      source: 'unavailable',
      failedToolName: SHELL_TOOL_NAME,
      failedCommand: 'npm test',
      commandRiskLevel: 'low',
      referencedTraceEvidence: false,
      traceEvidenceAvailable: false,
      unavailableReason: 'Phoenix MCP query timed out',
    });
    expect(plan.text).toContain('TracePilot repair plan unavailable');
    expect(plan.text).toContain('Phoenix MCP query timed out');
  });

  it('redacts trace evidence before adding it to the plan text', async () => {
    const plan = await buildTraceEvidenceRepairPlan(
      makeConfig(),
      makeFailedShellCall('npm test'),
      {
        attempted: true,
        available: true,
        evidence: {
          spanName: 'gemini_cli.tool.shell',
          toolName: SHELL_TOOL_NAME,
          exitCode: 1,
          outputPreview: 'OPENAI_API_KEY=sk-proj-demoSecret0000000000000000',
          outputSha256: 'hash',
        },
      },
    );

    expect(plan.text).toContain('[REDACTED]');
    expect(plan.text).not.toContain('sk-proj-demoSecret');
  });
});

function makeConfig(): Config {
  return {
    getSessionId: () => 'session-1',
    getTelemetryLogPromptsEnabled: () => true,
    getTelemetryTracesEnabled: () => true,
  } as unknown as Config;
}

function makeFailedShellCall(command: string): ErroredToolCall {
  return {
    status: CoreToolCallStatus.Error,
    request: {
      callId: 'call-shell',
      name: SHELL_TOOL_NAME,
      args: { command },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    response: {
      callId: 'call-shell',
      responseParts: [],
      resultDisplay: 'failed',
      error: new Error('Command failed'),
      errorType: ToolErrorType.SHELL_EXECUTE_ERROR,
    },
  };
}
