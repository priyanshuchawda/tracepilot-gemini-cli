/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ErroredToolCall } from '../scheduler/types.js';
import { MCPServerStatus, type McpClient } from '../tools/mcp-client.js';
import type { McpClientManager } from '../tools/mcp-client-manager.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_OUTPUT_PREVIEW,
  GEMINI_CLI_OUTPUT_SHA256,
  GeminiCliOperation,
  GEN_AI_TOOL_NAME,
} from './constants.js';
import { redactSensitiveText } from './sanitize.js';
import { flushTelemetry } from './sdk.js';
import { runInDevTraceSpan } from './trace.js';

const PHOENIX_MCP_TOOL_NAME = 'get-spans';
const DEFAULT_TIMEOUT_MS = 2000;

export interface PhoenixTraceEvidence {
  spanName?: string;
  toolName?: string;
  exitCode?: number;
  outputPreview?: string;
  outputSha256?: string;
}

export type PhoenixSelfIntrospectionResult =
  | {
      attempted: false;
      available: false;
      reason: string;
    }
  | {
      attempted: true;
      available: false;
      reason: string;
    }
  | {
      attempted: true;
      available: true;
      evidence: PhoenixTraceEvidence;
    };

export async function queryPhoenixForFailedToolCall(
  config: Config,
  call: ErroredToolCall,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PhoenixSelfIntrospectionResult> {
  try {
    await flushTelemetry(config);
  } catch (error) {
    return {
      attempted: true,
      available: false,
      reason: `Phoenix telemetry flush failed: ${getErrorMessage(error)}`,
    };
  }

  return runInDevTraceSpan(
    {
      operation: GeminiCliOperation.SelfIntrospection,
      logPrompts: config.getTelemetryLogPromptsEnabled(),
      tracesEnabled: config.getTelemetryTracesEnabled(),
      sessionId: config.getSessionId(),
      attributes: {
        [GEN_AI_TOOL_NAME]: call.request.name,
      },
    },
    async ({ metadata }) => {
      metadata.input = {
        callId: call.request.callId,
        toolName: call.request.name,
        status: call.status,
      };

      const manager = config.getMcpClientManager();
      const clientInfo = findPhoenixMcpClient(manager);
      if (!clientInfo) {
        const result: PhoenixSelfIntrospectionResult = {
          attempted: false,
          available: false,
          reason: 'Phoenix MCP client unavailable or disconnected.',
        };
        metadata.output = result;
        return result;
      }

      const phoenixTool = findPhoenixGetSpansTool(
        config,
        clientInfo.serverName,
      );
      if (!phoenixTool) {
        const result: PhoenixSelfIntrospectionResult = {
          attempted: true,
          available: false,
          reason: `Phoenix MCP server '${clientInfo.serverName}' does not expose a ${PHOENIX_MCP_TOOL_NAME} tool.`,
        };
        metadata.output = result;
        return result;
      }

      const args = buildPhoenixGetSpansArgs(config.getSessionId());
      try {
        const controller = new AbortController();
        const toolResult = await withTimeout(
          phoenixTool.buildAndExecute(args, controller.signal),
          timeoutMs,
          () => controller.abort(),
        );
        if (toolResult.error) {
          throw new Error(toolResult.error.message);
        }
        const evidence = extractEvidence({
          llmContent: toolResult.llmContent,
          returnDisplay: toolResult.returnDisplay,
          data: toolResult.data,
        });
        const result: PhoenixSelfIntrospectionResult = {
          attempted: true,
          available: true,
          evidence,
        };
        metadata.output = result;
        return result;
      } catch (error) {
        const result: PhoenixSelfIntrospectionResult = {
          attempted: true,
          available: false,
          reason: `Phoenix MCP query failed: ${getErrorMessage(error)}`,
        };
        metadata.error = error;
        metadata.output = result;
        return result;
      }
    },
  );
}

export function buildTraceRepairEvidenceText(
  result: PhoenixSelfIntrospectionResult,
): string {
  if (!result.available) {
    return `TracePilot Phoenix self-introspection unavailable: ${result.reason}`;
  }

  const fields = [
    `span=${result.evidence.spanName ?? 'unknown'}`,
    `tool=${result.evidence.toolName ?? 'unknown'}`,
    `exit_code=${result.evidence.exitCode ?? 'unknown'}`,
    `output_sha256=${result.evidence.outputSha256 ?? 'unknown'}`,
    `output_preview=${result.evidence.outputPreview ?? '(empty)'}`,
  ];
  return [
    'TracePilot Phoenix evidence for repair plan:',
    fields.join('\n'),
    'Use this trace evidence when planning the repair and rerun verification after applying the fix.',
  ].join('\n');
}

function findPhoenixMcpClient(
  manager: McpClientManager | undefined,
): { serverName: string; client: McpClient } | undefined {
  if (!manager) {
    return undefined;
  }
  const serverNames = Object.keys(manager.getMcpServers() ?? {}).filter(
    (name) => name.toLowerCase().includes('phoenix'),
  );
  for (const serverName of serverNames) {
    const client = manager.getClient(serverName);
    if (client?.getStatus() === MCPServerStatus.CONNECTED) {
      return { serverName, client };
    }
  }
  return undefined;
}

function findPhoenixGetSpansTool(
  config: Config,
  serverName: string,
): AnyDeclarativeTool | undefined {
  const tools = config.getToolRegistry().getToolsByServer(serverName);
  return tools.find((tool) => {
    const record = getRecord(tool);
    const serverToolName = getString(record, 'serverToolName');
    const candidates = [tool.name, serverToolName].filter(
      (candidate): candidate is string => candidate !== undefined,
    );
    return candidates.some(
      (candidate) => normalizeToolName(candidate) === 'get_spans',
    );
  });
}

function normalizeToolName(value: string): string {
  return value.toLowerCase().replaceAll('-', '_');
}

function buildPhoenixGetSpansArgs(sessionId: string): Record<string, unknown> {
  const startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const args: Record<string, unknown> = {
    start_time: startTime,
    names: [
      GeminiCliOperation.ToolShell,
      GeminiCliOperation.ToolFile,
      GeminiCliOperation.ToolMcp,
      GeminiCliOperation.ToolPhoenixMcp,
    ],
    limit: 20,
    session_id: sessionId,
  };
  if (process.env['PHOENIX_PROJECT']) {
    args['project_identifier'] = process.env['PHOENIX_PROJECT'];
  }
  return args;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new Error('Phoenix MCP query timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function extractEvidence(value: unknown): PhoenixTraceEvidence {
  const raw = JSON.parse(safeJsonStringify(value)) as unknown;
  const span = findSpanLikeObject(raw);
  const attributes = getRecord(span?.['attributes']);
  const previewValue = getString(attributes, GEMINI_CLI_OUTPUT_PREVIEW);
  const redactedPreview = previewValue
    ? redactSensitiveText(previewValue).value
    : undefined;

  return {
    spanName: getString(span, 'name'),
    toolName: getString(attributes, GEN_AI_TOOL_NAME),
    exitCode: getNumber(attributes, GEMINI_CLI_COMMAND_EXIT_CODE),
    outputPreview: redactedPreview,
    outputSha256: getString(attributes, GEMINI_CLI_OUTPUT_SHA256),
  };
}

function findSpanLikeObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSpanLikeObject(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }
  if (getString(record, 'name') && getRecord(record['attributes'])) {
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findSpanLikeObject(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}
