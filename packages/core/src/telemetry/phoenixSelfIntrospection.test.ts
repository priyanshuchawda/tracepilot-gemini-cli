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
import { ToolErrorType } from '../tools/tool-error.js';
import { SHELL_TOOL_NAME } from '../tools/tool-names.js';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_MCP_SERVER,
  GEMINI_CLI_MCP_TOOL,
  GEMINI_CLI_OUTPUT_PREVIEW,
  GEMINI_CLI_OUTPUT_SHA256,
  GeminiCliOperation,
  GEN_AI_TOOL_NAME,
} from './constants.js';
import {
  buildTraceRepairEvidenceText,
  queryPhoenixForFailedToolCall,
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
    const buildAndExecute = vi.fn().mockResolvedValue({
      llmContent: {
        spans: [
          {
            name: 'gemini_cli.tool.shell',
            attributes: {
              [GEN_AI_TOOL_NAME]: SHELL_TOOL_NAME,
              [GEMINI_CLI_COMMAND_EXIT_CODE]: 2,
              [GEMINI_CLI_OUTPUT_PREVIEW]:
                'Output: failing test\nOPENAI_API_KEY=sk-proj-redactedSecret000000',
              [GEMINI_CLI_OUTPUT_SHA256]: 'abc123',
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
      makeFailedShellCall(),
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
        names: expect.arrayContaining(['gemini_cli.tool.shell']),
        limit: 20,
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
      makeFailedShellCall(),
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
    });
  });

  it('queries Phoenix MCP directly from env when no configured MCP client exists', async () => {
    vi.stubEnv('PHOENIX_API_KEY', 'phx_test_key');
    vi.stubEnv('PHOENIX_PROJECT', 'tracepilot-test');
    vi.stubEnv(
      'PHOENIX_BASE_URL',
      'https://app.phoenix.arize.com/s/YOUR_SPACE',
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
      makeFailedShellCall(),
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
    expect(mcpClient.callTool).toHaveBeenCalledWith({
      name: 'get-spans',
      arguments: expect.objectContaining({
        project_identifier: 'tracepilot-test',
        session_id: 'session-1',
      }),
    });
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

function makeFailedShellCall(): ErroredToolCall {
  return {
    status: CoreToolCallStatus.Error,
    request: {
      callId: 'call-shell',
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
    },
  };
}
