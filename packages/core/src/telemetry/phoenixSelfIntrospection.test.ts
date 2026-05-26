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
import type { TracePilotFailureSignature } from '../tracepilot/failureSignature.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { SHELL_TOOL_NAME } from '../tools/tool-names.js';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_MCP_SERVER,
  GEMINI_CLI_MCP_TOOL,
  GEMINI_CLI_OUTPUT_PREVIEW,
  GEMINI_CLI_OUTPUT_SHA256,
  GEMINI_CLI_REPAIR_ROOT_CAUSE,
  GEMINI_CLI_REPAIR_SIGNATURE_ID,
  GEMINI_CLI_REPAIR_VERIFICATION_PASSED,
  GeminiCliOperation,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
} from './constants.js';
import {
  buildTraceRepairEvidenceText,
  queryPhoenixForFailedToolCall,
  queryPhoenixForHistoricalRepairs,
} from './phoenixSelfIntrospection.js';

const flushTelemetry = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runInDevTraceSpan = vi.hoisted(() =>
  vi.fn(async (_opts, fn) => fn({ metadata: { attributes: {} } })),
);
const mcpClient = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  callTool: vi.fn(),
}));
const stdioTransport = vi.hoisted(() => vi.fn((options) => ({ options })));

vi.mock('./sdk.js', () => ({
  flushTelemetry,
}));

vi.mock('./trace.js', () => ({
  runInDevTraceSpan,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => mcpClient),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: stdioTransport,
}));

describe('phoenix self introspection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('PHOENIX_API_KEY', '');
    vi.stubEnv('PHOENIX_PROJECT', '');
    vi.stubEnv('PHOENIX_HOST', '');
    vi.stubEnv('PHOENIX_BASE_URL', '');
    vi.stubEnv('PHOENIX_COLLECTOR_ENDPOINT', '');
    mcpClient.close.mockResolvedValue(undefined);
    mcpClient.connect.mockResolvedValue(undefined);
    mcpClient.callTool.mockReset();
  });

  it('degrades clearly when Phoenix MCP is unavailable', async () => {
    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => undefined,
    } as unknown as Config;

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall(),
    );

    expect(result).toMatchObject({
      attempted: false,
      available: false,
      reason: expect.stringContaining('Phoenix MCP client unavailable'),
    });
    expect(flushTelemetry).toHaveBeenCalledWith(config);
  });

  it('does not throw when telemetry flush fails before querying Phoenix MCP', async () => {
    flushTelemetry.mockRejectedValueOnce(new Error('flush failed'));
    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => undefined,
    } as unknown as Config;

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall(),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: false,
      reason: expect.stringContaining('Phoenix telemetry flush failed'),
    });
    expect(runInDevTraceSpan).not.toHaveBeenCalled();
  });

  it('queries Phoenix MCP and extracts safe failed span evidence', async () => {
    const startedAt = Date.parse('2026-05-26T10:00:00.000Z');
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: 'gemini_cli.tool.shell',
            start_time: '2026-05-26T10:00:01.000Z',
            attributes: {
              [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 2,
              [GEMINI_CLI_OUTPUT_PREVIEW]:
                'Output: failing test\nOPENAI_API_KEY=sk-proj-redactedSecret000000',
              [GEMINI_CLI_OUTPUT_SHA256]: 'abc123',
              'session.id': 'session-1',
            },
          },
        ],
      },
      returnDisplay: '',
    });

    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => ({
        getMcpServers: () => ({ phoenix: {} }),
        getClient: (serverName: string) =>
          serverName === 'phoenix'
            ? {
                getStatus: () => 'connected',
              }
            : undefined,
      }),
      getToolRegistry: () => ({
        getToolsByServer: (serverName: string) =>
          serverName === 'phoenix'
            ? [
                {
                  name: 'mcp_phoenix_get_spans',
                  serverToolName: 'get-spans',
                  buildAndExecute,
                },
              ]
            : [],
      }),
    } as unknown as Config;

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({
        startTime: startedAt,
        endTime: startedAt + 1000,
      }),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: {
        spanName: 'gemini_cli.tool.shell',
        toolName: SHELL_TOOL_NAME,
        exitCode: 2,
        outputSha256: 'abc123',
        outputPreview: expect.stringContaining('[REDACTED]'),
      },
    });
    if (!result.available) {
      throw new Error('Expected Phoenix self-introspection evidence');
    }
    expect(result.evidence?.outputPreview).not.toContain('sk-proj-redacted');
    expect(buildAndExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        names: [GeminiCliOperation.ToolShell],
        limit: 100,
      }),
      expect.any(AbortSignal),
    );
    expect(runInDevTraceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: GeminiCliOperation.ToolPhoenixMcp,
        sessionId: 'session-1',
        attributes: expect.objectContaining({
          [GEMINI_CLI_MCP_SERVER]: 'phoenix',
          [GEMINI_CLI_MCP_TOOL]: 'get-spans',
          [GEN_AI_TOOL_NAME]: 'get-spans',
        }),
      }),
      expect.any(Function),
    );
  });

  it('selects the matching failed tool span when Phoenix returns multiple spans', async () => {
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: 'gemini_cli.tool.file',
            attributes: {
              [GEN_AI_TOOL_NAME]: 'read_file',
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 0,
              [GEMINI_CLI_OUTPUT_PREVIEW]: 'Unrelated successful file read',
              [GEMINI_CLI_OUTPUT_SHA256]: 'unrelated-hash',
            },
          },
          {
            name: 'gemini_cli.tool.shell',
            attributes: {
              [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 7,
              [GEMINI_CLI_OUTPUT_PREVIEW]: 'AssertionError: matching failure',
              [GEMINI_CLI_OUTPUT_SHA256]: 'matching-hash',
            },
          },
        ],
      },
      returnDisplay: '',
    });

    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => ({
        getMcpServers: () => ({ phoenix: {} }),
        getClient: () => ({
          getStatus: () => 'connected',
        }),
      }),
      getToolRegistry: () => ({
        getToolsByServer: () => [
          {
            name: 'mcp_phoenix_get_spans',
            serverToolName: 'get-spans',
            buildAndExecute,
          },
        ],
      }),
    } as unknown as Config;

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({ data: { outputSha256: 'matching-hash' } }),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: {
        spanName: 'gemini_cli.tool.shell',
        toolName: SHELL_TOOL_NAME,
        exitCode: 7,
        outputPreview: 'AssertionError: matching failure',
        outputSha256: 'matching-hash',
      },
    });
  });

  it('does not claim trace evidence when Phoenix returns no spans', async () => {
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: { spans: [] },
      returnDisplay: '',
    });

    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => ({
        getMcpServers: () => ({ phoenix: {} }),
        getClient: () => ({
          getStatus: () => 'connected',
        }),
      }),
      getToolRegistry: () => ({
        getToolsByServer: () => [
          {
            name: 'mcp_phoenix_get_spans',
            serverToolName: 'get-spans',
            buildAndExecute,
          },
        ],
      }),
    } as unknown as Config;

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall(),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: false,
      reason: expect.stringContaining(
        'Phoenix MCP did not return matching failed span evidence',
      ),
      reasonCode: 'no_matching_span',
      diagnostics: expect.objectContaining({
        attemptedNames: [GeminiCliOperation.ToolShell],
        limit: 100,
        matchingEvidenceCount: 0,
        projectIdentifier: undefined,
        sessionId: 'session-1',
        spanCount: 0,
        toolName: 'get-spans',
      }),
    });
  });

  it('reports query diagnostics when the Phoenix limit may truncate results', async () => {
    const spans = Array.from({ length: 100 }, (_, index) => ({
      name: 'gemini_cli.tool.shell',
      attributes: {
        [GEN_AI_TOOL_NAME]: index === 99 ? SHELL_TOOL_NAME : 'other_tool',
        [GEMINI_CLI_COMMAND_EXIT_CODE]: index === 99 ? 1 : 0,
        [GEMINI_CLI_OUTPUT_SHA256]: `hash-${index}`,
      },
    }));
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: { spans },
      returnDisplay: '',
    });
    const config = makePhoenixConfig(buildAndExecute);

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({ data: { outputSha256: 'hash-99' } }),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      diagnostics: expect.objectContaining({
        attemptedNames: [GeminiCliOperation.ToolShell],
        limit: 100,
        limitTruncationPossible: true,
        matchingEvidenceCount: 1,
        spanCount: 100,
      }),
    });
  });

  it('paginates noisy failed-tool spans and selects exact causal evidence', async () => {
    const startedAt = Date.parse('2026-05-26T10:00:00.000Z');
    const noise = Array.from({ length: 100 }, (_, index) => ({
      name: 'gemini_cli.tool.shell',
      start_time: '2026-05-26T09:50:00.000Z',
      attributes: {
        [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
        [GEMINI_CLI_COMMAND_EXIT_CODE]: 1,
        [GEMINI_CLI_OUTPUT_SHA256]: `noise-${index}`,
        'session.id': 'other-session',
      },
    }));
    const buildAndExecute = vi
      .fn()
      .mockResolvedValueOnce({
        llmContent: { spans: noise, nextCursor: 'page-2' },
        returnDisplay: '',
      })
      .mockResolvedValueOnce({
        llmContent: {
          spans: [
            {
              name: 'gemini_cli.tool.shell',
              start_time: '2026-05-26T10:00:01.000Z',
              attributes: {
                [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
                [GEN_AI_TOOL_CALL_ID]: 'call-shell-exact',
                [GEMINI_CLI_COMMAND_EXIT_CODE]: 2,
                [GEMINI_CLI_OUTPUT_SHA256]: 'exact-hash',
                'session.id': 'replay-session',
              },
            },
          ],
        },
        returnDisplay: '',
      });
    const config = makePhoenixConfig(buildAndExecute);

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({
        callId: 'call-shell-exact',
        data: { exitCode: 2, outputSha256: 'exact-hash' },
        startTime: startedAt,
        endTime: startedAt + 1000,
      }),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: {
        exitCode: 2,
        outputSha256: 'exact-hash',
      },
      diagnostics: expect.objectContaining({
        candidateCount: 101,
        matchingEvidenceCount: 1,
        nextCursorSeen: true,
        pageSpanCounts: [100, 1],
        pages: 2,
        selectedEvidenceReason: expect.stringContaining('call_id'),
        selectedSpanTimestamp: '2026-05-26T10:00:01.000Z',
      }),
    });
    expect(buildAndExecute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'page-2' }),
      expect.any(AbortSignal),
    );
  });

  it('rejects duplicate-session and stale failed spans without exact evidence', async () => {
    const startedAt = Date.parse('2026-05-26T10:00:00.000Z');
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: 'gemini_cli.tool.shell',
            start_time: '2026-05-26T09:00:00.000Z',
            attributes: {
              [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
              [GEN_AI_TOOL_CALL_ID]: 'call-shell',
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 2,
              [GEMINI_CLI_OUTPUT_SHA256]: 'stale-other-session',
              'session.id': 'other-session',
            },
          },
          {
            name: 'gemini_cli.tool.shell',
            start_time: '2026-05-26T10:00:01.000Z',
            attributes: {
              [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 0,
              [GEMINI_CLI_OUTPUT_SHA256]: 'successful-current-session',
              'session.id': 'replay-session',
            },
          },
        ],
      },
      returnDisplay: '',
    });
    const config = makePhoenixConfig(buildAndExecute);

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({
        callId: 'call-shell',
        data: { exitCode: 2, outputSha256: 'missing-current-session-hash' },
        startTime: startedAt,
        endTime: startedAt + 1000,
      }),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: false,
      reasonCode: 'no_matching_span',
      diagnostics: expect.objectContaining({
        candidateCount: 2,
        matchingEvidenceCount: 0,
        pages: 1,
      }),
    });
  });

  it('rejects generic same-session failed spans without causal evidence', async () => {
    const startedAt = Date.parse('2026-05-26T10:00:00.000Z');
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: 'gemini_cli.tool.shell',
            attributes: {
              [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 1,
              [GEMINI_CLI_OUTPUT_PREVIEW]:
                'AssertionError: unrelated current-session failure',
              'session.id': 'replay-session',
            },
          },
        ],
      },
      returnDisplay: '',
    });
    const config = makePhoenixConfig(buildAndExecute);

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({
        startTime: startedAt,
        endTime: startedAt + 1000,
      }),
    );

    expect(result).toMatchObject({
      attempted: true,
      available: false,
      reasonCode: 'no_matching_span',
      diagnostics: expect.objectContaining({
        candidateCount: 1,
        matchingEvidenceCount: 0,
        selectedEvidenceReason: undefined,
      }),
    });
  });

  it('paginates historical repair memory and reports the selected reason', async () => {
    const noisyRepairs = Array.from({ length: 100 }, (_, index) => ({
      name: GeminiCliOperation.RepairReport,
      attributes: {
        [GEMINI_CLI_REPAIR_ROOT_CAUSE]: 'build_failure',
        [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
        'session.id': `noise-${index}`,
      },
    }));
    const buildAndExecute = vi
      .fn()
      .mockResolvedValueOnce({
        llmContent: { spans: noisyRepairs, nextCursor: 'repair-page-2' },
        returnDisplay: '',
      })
      .mockResolvedValueOnce({
        llmContent: {
          spans: [
            {
              name: GeminiCliOperation.RepairReport,
              start_time: '2026-05-26T10:10:00.000Z',
              attributes: {
                [GEMINI_CLI_REPAIR_SIGNATURE_ID]: 'tracepilot-failure-replay',
                [GEMINI_CLI_REPAIR_ROOT_CAUSE]: 'test_assertion_failure',
                [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
                'session.id': 'seed-session',
              },
            },
          ],
        },
        returnDisplay: '',
      });
    const config = makePhoenixConfig(buildAndExecute);
    const signature = {
      id: 'tracepilot-failure-replay',
      taxonomy: 'test_assertion_failure',
      commandFamily: 'npm test',
      diagnostics: [],
      stackFrames: [],
      files: [],
      dependencies: {},
      canonical: {},
    } as TracePilotFailureSignature;

    const result = await queryPhoenixForHistoricalRepairs(config, signature);

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: [{ sessionId: 'seed-session', verificationPassed: true }],
      diagnostics: expect.objectContaining({
        candidateCount: 101,
        matchingEvidenceCount: 1,
        nextCursorSeen: true,
        pageSpanCounts: [100, 1],
        pages: 2,
        selectedEvidenceReason: 'signature_id',
        selectedSpanTimestamp: '2026-05-26T10:10:00.000Z',
      }),
    });
    expect(buildAndExecute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'repair-page-2' }),
      expect.any(AbortSignal),
    );
  });

  it('retries Phoenix MCP errors with configured backoff diagnostics', async () => {
    vi.useFakeTimers();
    vi.stubEnv('TRACEPILOT_PHOENIX_MCP_RETRIES', '2');
    vi.stubEnv('TRACEPILOT_PHOENIX_MCP_RETRY_BACKOFF_MS', '25');
    const buildAndExecute = vi
      .fn()
      .mockResolvedValueOnce({
        error: { message: 'temporary Phoenix MCP outage token=secret123' },
      })
      .mockResolvedValueOnce({
        llmContent: {
          spans: [
            {
              name: 'gemini_cli.tool.shell',
              attributes: {
                [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
                [GEMINI_CLI_COMMAND_EXIT_CODE]: 1,
                [GEMINI_CLI_OUTPUT_SHA256]: 'retry-hash',
              },
            },
          ],
        },
        returnDisplay: '',
      });
    const config = makePhoenixConfig(buildAndExecute);

    const promise = queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({ data: { outputSha256: 'retry-hash' } }),
    );
    try {
      await vi.advanceTimersByTimeAsync(25);
      const result = await promise;

      expect(result).toMatchObject({
        attempted: true,
        available: true,
        evidence: {
          outputSha256: 'retry-hash',
        },
        diagnostics: expect.objectContaining({
          attempts: 2,
          maxAttempts: 2,
          retryBackoffMs: 25,
        }),
      });
      expect(buildAndExecute).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('secret123');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports sanitized final Phoenix MCP error diagnostics after retries', async () => {
    vi.useFakeTimers();
    vi.stubEnv('TRACEPILOT_PHOENIX_MCP_RETRIES', '2');
    vi.stubEnv('TRACEPILOT_PHOENIX_MCP_RETRY_BACKOFF_MS', '25');
    const buildAndExecute = vi.fn().mockResolvedValue({
      error: { message: 'permanent Phoenix MCP outage token=secret123' },
    });
    const config = makePhoenixConfig(buildAndExecute);

    const promise = queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall(),
    );
    try {
      await vi.advanceTimersByTimeAsync(25);
      const result = await promise;

      expect(result).toMatchObject({
        attempted: true,
        available: false,
        reasonCode: 'mcp_error',
        diagnostics: expect.objectContaining({
          attempts: 2,
          maxAttempts: 2,
          reasonCode: 'mcp_error',
          retryBackoffMs: 25,
        }),
      });
      expect(buildAndExecute).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('secret123');
    } finally {
      vi.useRealTimers();
    }
  });

  it('queries only verified repair reports for historical memory', async () => {
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: GeminiCliOperation.RepairReport,
            attributes: {
              [GEMINI_CLI_REPAIR_SIGNATURE_ID]: 'tracepilot-failure-replay',
              [GEMINI_CLI_REPAIR_ROOT_CAUSE]: 'test_assertion_failure',
              [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
              'session.id': 'seed-session',
            },
          },
        ],
      },
      returnDisplay: '',
    });
    const config = {
      getSessionId: () => 'replay-session',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => ({
        getMcpServers: () => ({ phoenix: {} }),
        getClient: () => ({
          getStatus: () => 'connected',
        }),
      }),
      getToolRegistry: () => ({
        getToolsByServer: () => [
          {
            name: 'mcp_phoenix_get_spans',
            serverToolName: 'get-spans',
            buildAndExecute,
          },
        ],
      }),
    } as unknown as Config;
    const signature = {
      id: 'tracepilot-failure-replay',
      taxonomy: 'test_assertion_failure',
      commandFamily: 'npm test',
      diagnostics: [],
      stackFrames: [],
      files: [],
      dependencies: {},
      canonical: {},
    } as TracePilotFailureSignature;

    const result = await queryPhoenixForHistoricalRepairs(config, signature);

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: [{ sessionId: 'seed-session', verificationPassed: true }],
    });
    expect(buildAndExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        names: [GeminiCliOperation.RepairReport],
      }),
      expect.any(AbortSignal),
    );
    expect(buildAndExecute.mock.calls[0]?.[0]).not.toHaveProperty('query');
  });

  it('ignores unrelated verified historical repairs without matching evidence', async () => {
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: GeminiCliOperation.RepairReport,
            attributes: {
              [GEMINI_CLI_REPAIR_ROOT_CAUSE]: 'build_failure',
              [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
              'session.id': 'unrelated-build-session',
            },
          },
          {
            name: GeminiCliOperation.RepairReport,
            attributes: {
              [GEMINI_CLI_REPAIR_ROOT_CAUSE]: 'test_assertion_failure',
              [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
              'session.id': 'broad-test-session',
            },
          },
        ],
      },
      returnDisplay: '',
    });
    const config = makePhoenixConfig(buildAndExecute);
    const signature = {
      id: 'tracepilot-failure-current',
      taxonomy: 'test_assertion_failure',
      commandFamily: 'test',
      diagnostics: ['assertionerror: expected api base url'],
      stackFrames: [],
      files: ['src/config.js'],
      dependencies: {},
      canonical: {},
    } as TracePilotFailureSignature;

    const result = await queryPhoenixForHistoricalRepairs(config, signature);

    expect(result).toMatchObject({
      attempted: true,
      available: false,
      evidence: [],
      reason: expect.stringContaining('returned no historical repair spans'),
    });
  });

  it('accepts legacy historical repairs when root cause has secondary diagnostic overlap', async () => {
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: GeminiCliOperation.RepairReport,
            attributes: {
              [GEMINI_CLI_REPAIR_ROOT_CAUSE]: 'test_assertion_failure',
              [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
              [GEMINI_CLI_OUTPUT_PREVIEW]:
                'AssertionError: expected API base URL in src/config.js',
              'session.id': 'legacy-overlap-session',
            },
          },
        ],
      },
      returnDisplay: '',
    });
    const config = makePhoenixConfig(buildAndExecute);
    const signature = {
      id: 'tracepilot-failure-current',
      taxonomy: 'test_assertion_failure',
      commandFamily: 'test',
      diagnostics: ['AssertionError: expected API base URL'],
      stackFrames: [],
      files: ['src/config.js'],
      dependencies: {},
      canonical: {},
    } as TracePilotFailureSignature;

    const result = await queryPhoenixForHistoricalRepairs(config, signature);

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: [{ sessionId: 'legacy-overlap-session' }],
    });
  });

  it('queries Phoenix MCP directly from env when no configured MCP client exists', async () => {
    vi.stubEnv('PHOENIX_API_KEY', 'phx_test_key');
    vi.stubEnv('PHOENIX_PROJECT', 'tracepilot-test');
    vi.stubEnv('PHOENIX_HOST', 'https://app.phoenix.arize.com/s/test-space');
    vi.stubEnv(
      'PHOENIX_BASE_URL',
      'https://app.phoenix.arize.com/s/test-space',
    );
    vi.stubEnv(
      'PHOENIX_COLLECTOR_ENDPOINT',
      'https://app.phoenix.arize.com/s/test-space/v1/traces',
    );
    mcpClient.callTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            spans: [
              {
                name: 'gemini_cli.tool.shell',
                attributes: {
                  [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
                  [GEMINI_CLI_COMMAND_EXIT_CODE]: 1,
                  [GEMINI_CLI_OUTPUT_PREVIEW]: 'AssertionError: expected URL',
                  [GEMINI_CLI_OUTPUT_SHA256]: 'hash123',
                },
              },
            ],
          }),
        },
      ],
    });
    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => undefined,
    } as unknown as Config;

    const result = await queryPhoenixForFailedToolCall(
      config,
      makeFailedShellCall({ data: { outputSha256: 'hash123' } }),
      123456,
    );

    expect(result).toMatchObject({
      attempted: true,
      available: true,
      evidence: {
        spanName: 'gemini_cli.tool.shell',
        exitCode: 1,
        outputSha256: 'hash123',
      },
    });
    expect(stdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npx',
        args: ['-y', '@arizeai/phoenix-mcp@4.0.13'],
        env: expect.objectContaining({
          PHOENIX_API_KEY: 'phx_test_key',
          PHOENIX_HOST: 'https://app.phoenix.arize.com/s/test-space',
          PHOENIX_PROJECT: 'tracepilot-test',
        }),
      }),
    );
    expect(mcpClient.callTool).toHaveBeenCalledWith(
      {
        name: 'get-spans',
        arguments: expect.objectContaining({
          project_identifier: 'tracepilot-test',
          session_id: 'session-1',
        }),
      },
      undefined,
      { timeout: 123456 },
    );
    expect(runInDevTraceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: GeminiCliOperation.ToolPhoenixMcp,
        attributes: expect.objectContaining({
          [GEMINI_CLI_MCP_SERVER]: 'tracepilot-phoenix-env',
          [GEMINI_CLI_MCP_TOOL]: 'get-spans',
        }),
      }),
      expect.any(Function),
    );
  });

  it('honors an explicit Phoenix MCP package override for direct env queries', async () => {
    vi.stubEnv('PHOENIX_API_KEY', 'phx_test_key');
    vi.stubEnv('PHOENIX_PROJECT', 'tracepilot-test');
    vi.stubEnv('PHOENIX_HOST', 'https://app.phoenix.arize.com/s/demo');
    vi.stubEnv('PHOENIX_BASE_URL', 'https://app.phoenix.arize.com/s/demo');
    vi.stubEnv('TRACEPILOT_PHOENIX_MCP_PACKAGE', '@arizeai/phoenix-mcp@4.0.12');
    mcpClient.callTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            spans: [
              {
                name: 'gemini_cli.tool.shell',
                attributes: {
                  [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
                  [GEMINI_CLI_COMMAND_EXIT_CODE]: 1,
                  [GEMINI_CLI_OUTPUT_SHA256]: 'override-hash',
                },
              },
            ],
          }),
        },
      ],
    });
    const config = {
      getSessionId: () => 'session-1',
      getTelemetryLogPromptsEnabled: () => true,
      getTelemetryTracesEnabled: () => true,
      getMcpClientManager: () => undefined,
    } as unknown as Config;

    await queryPhoenixForFailedToolCall(config, makeFailedShellCall());

    expect(stdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-y', '@arizeai/phoenix-mcp@4.0.12'],
      }),
    );
  });

  it('formats trace evidence as repair-planning context without raw secrets', () => {
    const text = buildTraceRepairEvidenceText({
      attempted: true,
      available: true,
      evidence: {
        spanName: 'gemini_cli.tool.shell',
        toolName: SHELL_TOOL_NAME,
        exitCode: 1,
        outputPreview: 'Error: [REDACTED]',
        outputSha256: 'hash',
      },
    });

    expect(text).toContain('TracePilot Phoenix evidence');
    expect(text).toContain('repair plan');
    expect(text).toContain('gemini_cli.tool.shell');
    expect(text).not.toContain('sk-');
  });
});

function makeFailedShellCall(
  options: {
    callId?: string;
    data?: Record<string, unknown>;
    startTime?: number;
    endTime?: number;
  } = {},
): ErroredToolCall {
  return {
    status: CoreToolCallStatus.Error,
    request: {
      callId: options.callId ?? 'call-shell',
      name: SHELL_TOOL_NAME,
      args: { command: 'npm test' },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    response: {
      callId: 'call-shell',
      responseParts: [],
      resultDisplay: 'failed',
      error: new Error('Command failed'),
      errorType: ToolErrorType.SHELL_EXECUTE_ERROR,
      data: options.data,
    },
    startTime: options.startTime,
    endTime: options.endTime,
  };
}

function makePhoenixConfig(buildAndExecute: ReturnType<typeof vi.fn>): Config {
  return {
    getSessionId: () => 'replay-session',
    getTelemetryLogPromptsEnabled: () => true,
    getTelemetryTracesEnabled: () => true,
    getMcpClientManager: () => ({
      getMcpServers: () => ({ phoenix: {} }),
      getClient: () => ({
        getStatus: () => 'connected',
      }),
    }),
    getToolRegistry: () => ({
      getToolsByServer: () => [
        {
          name: 'mcp_phoenix_get_spans',
          serverToolName: 'get-spans',
          buildAndExecute,
        },
      ],
    }),
  } as unknown as Config;
}
