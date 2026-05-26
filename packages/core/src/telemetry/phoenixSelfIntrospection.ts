/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ErroredToolCall } from '../scheduler/types.js';
import { MCPServerStatus, type McpClient } from '../tools/mcp-client.js';
import type { McpClientManager } from '../tools/mcp-client-manager.js';
import { SHELL_TOOL_NAME } from '../tools/tool-names.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_MCP_QUERY_COUNT,
  GEMINI_CLI_MCP_SERVER,
  GEMINI_CLI_MCP_TOOL,
  GEMINI_CLI_OUTPUT_PREVIEW,
  GEMINI_CLI_OUTPUT_SHA256,
  GEMINI_CLI_PHOENIX_TRACE_IDS_CONSULTED,
  GEMINI_CLI_REPAIR_CONFIDENCE_SCORE,
  GEMINI_CLI_REPAIR_FINGERPRINT,
  GEMINI_CLI_REPAIR_ROOT_CAUSE,
  GEMINI_CLI_REPAIR_SIGNATURE_ID,
  GEMINI_CLI_REPAIR_STRATEGY,
  GEMINI_CLI_REPAIR_VERIFICATION_PASSED,
  GeminiCliOperation,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
} from './constants.js';
import type { TracePilotFailureSignature } from '../tracepilot/failureSignature.js';
import { redactSensitiveText } from './sanitize.js';
import { flushTelemetry } from './sdk.js';
import { runInDevTraceSpan } from './trace.js';
import {
  callDirectPhoenixMcpGetSpans,
  collectSpanLikeObjects,
  DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS,
  DIRECT_PHOENIX_MCP_SERVER_NAME,
  getBoolean,
  getNumber,
  getRecord,
  getString,
  getStringList,
  PHOENIX_MCP_TOOL_NAME,
  resolveDirectPhoenixMcpConfig,
  type PhoenixMcpToolResult,
  withPhoenixMcpTimeout,
} from './phoenixMcpUtils.js';

const DEFAULT_TIMEOUT_MS = DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS;
const DEFAULT_PHOENIX_MCP_PAGE_LIMIT = 100;
const DEFAULT_PHOENIX_MCP_MAX_PAGES = 3;
const DEFAULT_FAILED_TOOL_LOOKBACK_MS = 60 * 60 * 1000;
const WIDENED_FAILED_TOOL_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const TOOL_CALL_TIME_BUFFER_MS = 5 * 60 * 1000;
const PHOENIX_MCP_RETRIES_ENV = 'TRACEPILOT_PHOENIX_MCP_RETRIES';
const PHOENIX_MCP_RETRY_BACKOFF_MS_ENV =
  'TRACEPILOT_PHOENIX_MCP_RETRY_BACKOFF_MS';

export type PhoenixQueryFailureReasonCode =
  | 'flush_failed'
  | 'mcp_unavailable'
  | 'mcp_error'
  | 'timeout'
  | 'no_matching_span';

export interface PhoenixQueryDiagnostics {
  reasonCode?: PhoenixQueryFailureReasonCode;
  serverName?: string;
  toolName: string;
  attemptedNames: string[];
  projectIdentifier?: string;
  sessionId?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  spanCount?: number;
  candidateCount?: number;
  matchingEvidenceCount?: number;
  attempts: number;
  maxAttempts: number;
  pages: number;
  maxPages: number;
  pageSpanCounts: number[];
  retryBackoffMs: number;
  limitTruncationPossible: boolean;
  nextCursorSeen: boolean;
  queryWidened: boolean;
  selectedEvidenceReason?: string;
  selectedSpanTimestamp?: string;
}

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
      reasonCode?: PhoenixQueryFailureReasonCode;
      diagnostics?: PhoenixQueryDiagnostics;
    }
  | {
      attempted: true;
      available: false;
      reason: string;
      reasonCode?: PhoenixQueryFailureReasonCode;
      diagnostics?: PhoenixQueryDiagnostics;
    }
  | {
      attempted: true;
      available: true;
      evidence: PhoenixTraceEvidence;
      diagnostics?: PhoenixQueryDiagnostics;
    };

export interface PhoenixHistoricalRepairEvidence {
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  signatureId?: string;
  repairFingerprint?: string;
  rootCause?: string;
  strategy?: string[];
  confidenceScore?: number;
  verificationPassed?: boolean;
  outputSha256?: string;
  outputPreview?: string;
  spanTimestamp?: string;
}

export type PhoenixHistoricalRepairQueryResult =
  | {
      attempted: false;
      available: false;
      reason: string;
      reasonCode?: PhoenixQueryFailureReasonCode;
      diagnostics?: PhoenixQueryDiagnostics;
      evidence: [];
    }
  | {
      attempted: true;
      available: false;
      reason: string;
      reasonCode?: PhoenixQueryFailureReasonCode;
      diagnostics?: PhoenixQueryDiagnostics;
      evidence: [];
    }
  | {
      attempted: true;
      available: true;
      evidence: PhoenixHistoricalRepairEvidence[];
      diagnostics?: PhoenixQueryDiagnostics;
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
      reason: `Phoenix telemetry flush failed: ${
        redactSensitiveText(getErrorMessage(error)).value
      }`,
      reasonCode: 'flush_failed',
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

      const args = buildPhoenixGetSpansArgs(config.getSessionId(), call);
      const retryOptions = getPhoenixRetryOptions(process.env);
      const phoenixQuery = getPhoenixMcpQuery(config, timeoutMs);
      if (!phoenixQuery) {
        const result: PhoenixSelfIntrospectionResult = {
          attempted: false,
          available: false,
          reason:
            'Phoenix MCP client unavailable or PHOENIX_API_KEY/PHOENIX_PROJECT/Phoenix host env is missing.',
          reasonCode: 'mcp_unavailable',
          diagnostics: buildPhoenixQueryDiagnostics({
            args,
            reasonCode: 'mcp_unavailable',
            retryOptions,
          }),
        };
        metadata.output = result;
        return result;
      }

      try {
        const toolQuery = await runInDevTraceSpan(
          {
            operation: GeminiCliOperation.ToolPhoenixMcp,
            logPrompts: config.getTelemetryLogPromptsEnabled(),
            tracesEnabled: config.getTelemetryTracesEnabled(),
            sessionId: config.getSessionId(),
            attributes: {
              [GEN_AI_TOOL_NAME]: PHOENIX_MCP_TOOL_NAME,
              [GEMINI_CLI_MCP_SERVER]: phoenixQuery.serverName,
              [GEMINI_CLI_MCP_TOOL]: PHOENIX_MCP_TOOL_NAME,
            },
          },
          async ({ metadata }) => {
            metadata.input = {
              serverName: phoenixQuery.serverName,
              toolName: PHOENIX_MCP_TOOL_NAME,
              args,
            };

            const queryResult = await executePhoenixPagedQuery(
              (pageArgs, signal) => phoenixQuery.execute(pageArgs, signal),
              args,
              timeoutMs,
              retryOptions,
              {
                widenStartTime: getWidenedFailedToolStartTime(call),
              },
            );
            const { result } = queryResult;
            const diagnostics = buildPhoenixQueryDiagnostics({
              args,
              serverName: phoenixQuery.serverName,
              result,
              attempts: queryResult.attempts,
              pages: queryResult.pages,
              maxPages: queryResult.maxPages,
              pageSpanCounts: queryResult.pageSpanCounts,
              nextCursorSeen: queryResult.nextCursorSeen,
              queryWidened: queryResult.queryWidened,
              retryOptions,
            });

            if (result.error) {
              metadata.error = result.error;
              metadata.output = {
                status: 'error',
                message: redactSensitiveText(result.error.message).value,
                diagnostics,
              };
            } else {
              metadata.output = { status: 'ok', diagnostics };
            }
            return { result, diagnostics };
          },
        );
        const toolResult = toolQuery.result;
        if (toolResult.error) {
          const reasonCode = classifyPhoenixQueryError(
            toolResult.error.message,
          );
          const result: PhoenixSelfIntrospectionResult = {
            attempted: true,
            available: false,
            reason: `Phoenix MCP query failed: ${
              redactSensitiveText(toolResult.error.message).value
            }`,
            reasonCode,
            diagnostics: {
              ...toolQuery.diagnostics,
              reasonCode,
            },
          };
          metadata.output = result;
          return result;
        }
        const evidenceMatch = extractEvidence(
          {
            llmContent: toolResult.llmContent,
            returnDisplay: toolResult.returnDisplay,
            data: toolResult.data,
          },
          {
            call,
            sessionId: config.getSessionId(),
          },
        );
        const diagnostics = buildPhoenixQueryDiagnostics({
          args,
          serverName: phoenixQuery.serverName,
          result: toolResult,
          attempts: toolQuery.diagnostics.attempts,
          pages: toolQuery.diagnostics.pages,
          maxPages: toolQuery.diagnostics.maxPages,
          pageSpanCounts: toolQuery.diagnostics.pageSpanCounts,
          nextCursorSeen: toolQuery.diagnostics.nextCursorSeen,
          queryWidened: toolQuery.diagnostics.queryWidened,
          matchingEvidenceCount: evidenceMatch ? 1 : 0,
          selectedEvidenceReason: evidenceMatch?.reason,
          selectedSpanTimestamp: evidenceMatch?.timestamp,
          retryOptions,
        });
        if (!evidenceMatch) {
          const result: PhoenixSelfIntrospectionResult = {
            attempted: true,
            available: false,
            reason: `Phoenix MCP did not return matching failed span evidence for ${call.request.name}.`,
            reasonCode: 'no_matching_span',
            diagnostics: {
              ...diagnostics,
              reasonCode: 'no_matching_span',
            },
          };
          metadata.output = result;
          return result;
        }
        const result: PhoenixSelfIntrospectionResult = {
          attempted: true,
          available: true,
          evidence: evidenceMatch.evidence,
          diagnostics,
        };
        metadata.output = result;
        return result;
      } catch (error) {
        const reasonCode = classifyPhoenixQueryError(error);
        const result: PhoenixSelfIntrospectionResult = {
          attempted: true,
          available: false,
          reason: `Phoenix MCP query failed: ${
            redactSensitiveText(getErrorMessage(error)).value
          }`,
          reasonCode,
          diagnostics: buildPhoenixQueryDiagnostics({
            args,
            serverName: phoenixQuery.serverName,
            reasonCode,
            retryOptions,
          }),
        };
        metadata.error = error;
        metadata.output = result;
        return result;
      }
    },
  );
}

export async function queryPhoenixForHistoricalRepairs(
  config: Config,
  signature: TracePilotFailureSignature,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PhoenixHistoricalRepairQueryResult> {
  try {
    await flushTelemetry(config);
  } catch (error) {
    return {
      attempted: true,
      available: false,
      reason: `Phoenix telemetry flush failed before historical repair query: ${
        redactSensitiveText(getErrorMessage(error)).value
      }`,
      reasonCode: 'flush_failed',
      evidence: [],
    };
  }

  return runInDevTraceSpan(
    {
      operation: GeminiCliOperation.RepairMemoryRetrieve,
      logPrompts: config.getTelemetryLogPromptsEnabled(),
      tracesEnabled: config.getTelemetryTracesEnabled(),
      sessionId: config.getSessionId(),
      attributes: {
        [GEMINI_CLI_REPAIR_SIGNATURE_ID]: signature.id,
        [GEMINI_CLI_REPAIR_ROOT_CAUSE]: signature.taxonomy,
      },
    },
    async ({ metadata }) => {
      metadata.input = {
        signatureId: signature.id,
        taxonomy: signature.taxonomy,
        commandFamily: signature.commandFamily,
        outputSha256: signature.outputSha256,
      };

      const args = buildPhoenixHistoricalRepairArgs(signature);
      const retryOptions = getPhoenixRetryOptions(process.env);
      const phoenixQuery = getPhoenixMcpQuery(config, timeoutMs);
      if (!phoenixQuery) {
        const result: PhoenixHistoricalRepairQueryResult = {
          attempted: false,
          available: false,
          reason:
            'Phoenix MCP client unavailable or PHOENIX_API_KEY/PHOENIX_PROJECT/Phoenix host env is missing.',
          reasonCode: 'mcp_unavailable',
          diagnostics: buildPhoenixQueryDiagnostics({
            args,
            reasonCode: 'mcp_unavailable',
            retryOptions,
          }),
          evidence: [],
        };
        metadata.output = result;
        return result;
      }

      try {
        const toolQuery = await runInDevTraceSpan(
          {
            operation: GeminiCliOperation.ToolPhoenixMcp,
            logPrompts: config.getTelemetryLogPromptsEnabled(),
            tracesEnabled: config.getTelemetryTracesEnabled(),
            sessionId: config.getSessionId(),
            attributes: {
              [GEN_AI_TOOL_NAME]: PHOENIX_MCP_TOOL_NAME,
              [GEMINI_CLI_MCP_SERVER]: phoenixQuery.serverName,
              [GEMINI_CLI_MCP_TOOL]: PHOENIX_MCP_TOOL_NAME,
            },
          },
          async ({ metadata }) => {
            metadata.input = {
              serverName: phoenixQuery.serverName,
              toolName: PHOENIX_MCP_TOOL_NAME,
              args,
            };

            const queryResult = await executePhoenixPagedQuery(
              (pageArgs, signal) => phoenixQuery.execute(pageArgs, signal),
              args,
              timeoutMs,
              retryOptions,
            );
            const { result } = queryResult;
            const diagnostics = buildPhoenixQueryDiagnostics({
              args,
              serverName: phoenixQuery.serverName,
              result,
              attempts: queryResult.attempts,
              pages: queryResult.pages,
              maxPages: queryResult.maxPages,
              pageSpanCounts: queryResult.pageSpanCounts,
              nextCursorSeen: queryResult.nextCursorSeen,
              queryWidened: queryResult.queryWidened,
              retryOptions,
            });

            if (result.error) {
              metadata.error = result.error;
              metadata.output = {
                status: 'error',
                message: redactSensitiveText(result.error.message).value,
                diagnostics,
              };
            } else {
              metadata.output = { status: 'ok', diagnostics };
            }
            return { result, diagnostics };
          },
        );
        const toolResult = toolQuery.result;
        if (toolResult.error) {
          const reasonCode = classifyPhoenixQueryError(
            toolResult.error.message,
          );
          const result: PhoenixHistoricalRepairQueryResult = {
            attempted: true,
            available: false,
            reason: `Phoenix historical repair query failed: ${
              redactSensitiveText(toolResult.error.message).value
            }`,
            reasonCode,
            diagnostics: {
              ...toolQuery.diagnostics,
              reasonCode,
            },
            evidence: [],
          };
          metadata.output = result;
          return result;
        }
        const evidence = extractHistoricalRepairEvidence(
          {
            llmContent: toolResult.llmContent,
            returnDisplay: toolResult.returnDisplay,
            data: toolResult.data,
          },
          signature,
        );
        const diagnostics = buildPhoenixQueryDiagnostics({
          args,
          serverName: phoenixQuery.serverName,
          result: toolResult,
          attempts: toolQuery.diagnostics.attempts,
          pages: toolQuery.diagnostics.pages,
          maxPages: toolQuery.diagnostics.maxPages,
          pageSpanCounts: toolQuery.diagnostics.pageSpanCounts,
          nextCursorSeen: toolQuery.diagnostics.nextCursorSeen,
          queryWidened: toolQuery.diagnostics.queryWidened,
          matchingEvidenceCount: evidence.length,
          selectedEvidenceReason: getHistoricalRepairEvidenceReason(
            evidence[0],
            signature,
          ),
          selectedSpanTimestamp: evidence[0]?.spanTimestamp,
          retryOptions,
        });
        const result: PhoenixHistoricalRepairQueryResult =
          evidence.length > 0
            ? {
                attempted: true,
                available: true,
                evidence,
                diagnostics,
              }
            : {
                attempted: true,
                available: false,
                reason: `Phoenix MCP returned no historical repair spans matching ${signature.id}.`,
                reasonCode: 'no_matching_span',
                diagnostics: {
                  ...diagnostics,
                  reasonCode: 'no_matching_span',
                },
                evidence: [],
              };

        metadata.attributes[GEMINI_CLI_MCP_QUERY_COUNT] = 1;
        metadata.attributes[GEMINI_CLI_PHOENIX_TRACE_IDS_CONSULTED] = evidence
          .map((item) => item.traceId)
          .filter((value): value is string => value !== undefined)
          .join(',');
        metadata.output = result;
        return result;
      } catch (error) {
        const reasonCode = classifyPhoenixQueryError(error);
        const result: PhoenixHistoricalRepairQueryResult = {
          attempted: true,
          available: false,
          reason: `Phoenix historical repair query failed: ${
            redactSensitiveText(getErrorMessage(error)).value
          }`,
          reasonCode,
          diagnostics: buildPhoenixQueryDiagnostics({
            args,
            serverName: phoenixQuery.serverName,
            reasonCode,
            retryOptions,
          }),
          evidence: [],
        };
        metadata.error = error;
        metadata.output = result;
        return result;
      }
    },
  );
}

function getPhoenixMcpQuery(
  config: Config,
  timeoutMs: number,
):
  | {
      serverName: string;
      execute: (
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<PhoenixMcpToolResult>;
    }
  | undefined {
  const manager = config.getMcpClientManager();
  const clientInfo = findPhoenixMcpClient(manager);
  if (clientInfo) {
    const phoenixTool = findPhoenixGetSpansTool(config, clientInfo.serverName);
    if (phoenixTool) {
      return {
        serverName: clientInfo.serverName,
        execute: (args, signal) => phoenixTool.buildAndExecute(args, signal),
      };
    }
  }

  const directConfig = resolveDirectPhoenixMcpConfig(process.env);
  if (!directConfig) {
    return undefined;
  }

  return {
    serverName: DIRECT_PHOENIX_MCP_SERVER_NAME,
    execute: (args) =>
      callDirectPhoenixMcpGetSpans(args, directConfig, {
        clientName: 'tracepilot-phoenix-self-introspection',
        timeoutMs,
      }),
  };
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

function buildPhoenixGetSpansArgs(
  sessionId: string,
  call: ErroredToolCall,
): Record<string, unknown> {
  const { startTime, endTime } = getFailedToolQueryWindow(call);
  const args: Record<string, unknown> = {
    start_time: startTime,
    names:
      call.request.name === SHELL_TOOL_NAME
        ? [GeminiCliOperation.ToolShell]
        : [
            GeminiCliOperation.ToolShell,
            GeminiCliOperation.ToolFile,
            GeminiCliOperation.ToolMcp,
            GeminiCliOperation.ToolPhoenixMcp,
          ],
    limit: DEFAULT_PHOENIX_MCP_PAGE_LIMIT,
    session_id: sessionId,
  };
  if (endTime) {
    args['end_time'] = endTime;
  }
  if (process.env['PHOENIX_PROJECT']) {
    args['project_identifier'] = process.env['PHOENIX_PROJECT'];
  }
  return args;
}

function getFailedToolQueryWindow(call: ErroredToolCall): {
  startTime: string;
  endTime?: string;
} {
  if (call.startTime !== undefined || call.endTime !== undefined) {
    const start = (call.startTime ?? Date.now()) - TOOL_CALL_TIME_BUFFER_MS;
    const end = (call.endTime ?? Date.now()) + TOOL_CALL_TIME_BUFFER_MS;
    return {
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
    };
  }
  return {
    startTime: new Date(
      Date.now() - DEFAULT_FAILED_TOOL_LOOKBACK_MS,
    ).toISOString(),
  };
}

function getWidenedFailedToolStartTime(
  call: ErroredToolCall,
): string | undefined {
  if (call.startTime !== undefined || call.endTime !== undefined) {
    return undefined;
  }
  return new Date(Date.now() - WIDENED_FAILED_TOOL_LOOKBACK_MS).toISOString();
}

function buildPhoenixHistoricalRepairArgs(
  _signature: TracePilotFailureSignature,
): Record<string, unknown> {
  const startTime = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const args: Record<string, unknown> = {
    start_time: startTime,
    names: [GeminiCliOperation.RepairReport],
    limit: DEFAULT_PHOENIX_MCP_PAGE_LIMIT,
  };
  if (process.env['PHOENIX_PROJECT']) {
    args['project_identifier'] = process.env['PHOENIX_PROJECT'];
  }
  // Query only verified outcome spans, then score relevance client-side. Text
  // filters can hide a reusable repair when output hashes differ between runs.
  return args;
}

interface PhoenixRetryOptions {
  maxAttempts: number;
  backoffMs: number;
}

interface PhoenixPagedQueryResult {
  result: PhoenixMcpToolResult;
  attempts: number;
  pages: number;
  maxPages: number;
  pageSpanCounts: number[];
  nextCursorSeen: boolean;
  queryWidened: boolean;
}

interface FailedToolEvidenceMatch {
  evidence: PhoenixTraceEvidence;
  reason: string;
  timestamp?: string;
  score: number;
}

async function executePhoenixQueryWithRetry(
  execute: () => Promise<PhoenixMcpToolResult>,
  options: PhoenixRetryOptions,
): Promise<{ result: PhoenixMcpToolResult; attempts: number }> {
  let attempts = 0;
  let lastError: unknown;

  while (attempts < options.maxAttempts) {
    attempts++;
    try {
      const result = await execute();
      if (!result.error || attempts >= options.maxAttempts) {
        return { result, attempts };
      }
      lastError = new Error(result.error.message);
    } catch (error) {
      lastError = error;
      if (attempts >= options.maxAttempts) {
        throw error;
      }
    }
    await sleep(options.backoffMs);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Phoenix MCP query failed');
}

async function executePhoenixPagedQuery(
  execute: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<PhoenixMcpToolResult>,
  baseArgs: Record<string, unknown>,
  timeoutMs: number,
  retryOptions: PhoenixRetryOptions,
  options: {
    maxPages?: number;
    widenStartTime?: string;
  } = {},
): Promise<PhoenixPagedQueryResult> {
  const maxPages = options.maxPages ?? DEFAULT_PHOENIX_MCP_MAX_PAGES;
  const limit = getNumber(baseArgs, 'limit') ?? DEFAULT_PHOENIX_MCP_PAGE_LIMIT;
  let cursor: string | undefined;
  let attempts = 0;
  let pages = 0;
  let nextCursorSeen = false;
  let queryWidened = false;
  const pageSpanCounts: number[] = [];
  const spansByStableKey = new Map<string, Record<string, unknown>>();

  while (pages < maxPages) {
    const pageArgs = {
      ...baseArgs,
      limit,
      ...(cursor ? { cursor } : {}),
    };
    const controller = new AbortController();
    const page = await executePhoenixQueryWithRetry(
      () =>
        withPhoenixMcpTimeout(
          execute(pageArgs, controller.signal),
          timeoutMs,
          () => controller.abort(),
        ),
      retryOptions,
    );
    attempts += page.attempts;
    const { result } = page;
    if (result.error) {
      return {
        result,
        attempts,
        pages: pages + 1,
        maxPages,
        pageSpanCounts,
        nextCursorSeen,
        queryWidened,
      };
    }

    const spans = getPhoenixResultSpans(result);
    pages++;
    pageSpanCounts.push(spans.length);
    for (const span of spans) {
      spansByStableKey.set(getSpanStableKey(span), span);
    }

    cursor = getPhoenixNextCursor(result);
    if (cursor) {
      nextCursorSeen = true;
      continue;
    }

    const truncationPossible = spans.length >= limit;
    if (
      (truncationPossible || spans.length === 0) &&
      options.widenStartTime &&
      getString(baseArgs, 'start_time') !== options.widenStartTime &&
      pages < maxPages
    ) {
      baseArgs = {
        ...baseArgs,
        start_time: options.widenStartTime,
      };
      queryWidened = true;
      continue;
    }
    break;
  }

  const spans = [...spansByStableKey.values()];
  return {
    result: {
      llmContent: { spans },
      returnDisplay: '',
      data: { spans },
    },
    attempts,
    pages,
    maxPages,
    pageSpanCounts,
    nextCursorSeen,
    queryWidened,
  };
}

function getPhoenixRetryOptions(env: NodeJS.ProcessEnv): PhoenixRetryOptions {
  return {
    maxAttempts: Math.max(1, parsePositiveInt(env[PHOENIX_MCP_RETRIES_ENV], 1)),
    backoffMs: parsePositiveInt(env[PHOENIX_MCP_RETRY_BACKOFF_MS_ENV], 250),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyPhoenixQueryError(
  error: unknown,
): PhoenixQueryFailureReasonCode {
  return getErrorMessage(error).toLowerCase().includes('timed out')
    ? 'timeout'
    : 'mcp_error';
}

function buildPhoenixQueryDiagnostics(input: {
  args: Record<string, unknown>;
  serverName?: string;
  result?: PhoenixMcpToolResult;
  reasonCode?: PhoenixQueryFailureReasonCode;
  matchingEvidenceCount?: number;
  selectedEvidenceReason?: string;
  selectedSpanTimestamp?: string;
  attempts?: number;
  pages?: number;
  maxPages?: number;
  pageSpanCounts?: number[];
  nextCursorSeen?: boolean;
  queryWidened?: boolean;
  retryOptions: PhoenixRetryOptions;
}): PhoenixQueryDiagnostics {
  const spans =
    input.result === undefined
      ? undefined
      : getPhoenixResultSpans(
          JSON.parse(
            safeJsonStringify({
              llmContent: input.result.llmContent,
              returnDisplay: input.result.returnDisplay,
              data: input.result.data,
            }),
          ) as unknown,
        );
  const limit = getNumber(input.args, 'limit');
  const spanCount = spans?.length;
  return {
    reasonCode: input.reasonCode,
    serverName: input.serverName,
    toolName: PHOENIX_MCP_TOOL_NAME,
    attemptedNames: getStringList(input.args, 'names'),
    projectIdentifier: getString(input.args, 'project_identifier'),
    sessionId: getString(input.args, 'session_id'),
    startTime: getString(input.args, 'start_time'),
    endTime: getString(input.args, 'end_time'),
    limit,
    spanCount,
    candidateCount: spanCount,
    matchingEvidenceCount: input.matchingEvidenceCount,
    attempts: input.attempts ?? 0,
    maxAttempts: input.retryOptions.maxAttempts,
    pages: input.pages ?? 0,
    maxPages: input.maxPages ?? DEFAULT_PHOENIX_MCP_MAX_PAGES,
    pageSpanCounts: input.pageSpanCounts ?? [],
    retryBackoffMs: input.retryOptions.backoffMs,
    limitTruncationPossible:
      spanCount !== undefined && limit !== undefined && spanCount >= limit,
    nextCursorSeen: input.nextCursorSeen ?? false,
    queryWidened: input.queryWidened ?? false,
    selectedEvidenceReason: input.selectedEvidenceReason,
    selectedSpanTimestamp: input.selectedSpanTimestamp,
  };
}

function getPhoenixResultSpans(
  value: PhoenixMcpToolResult | unknown,
): Array<Record<string, unknown>> {
  const result = getRecord(value);
  if (
    result &&
    ('llmContent' in result || 'returnDisplay' in result || 'data' in result)
  ) {
    return collectSpanLikeObjects({
      llmContent: result['llmContent'],
      returnDisplay: result['returnDisplay'],
      data: result['data'],
    });
  }
  return collectSpanLikeObjects(value);
}

function getPhoenixNextCursor(
  result: PhoenixMcpToolResult,
): string | undefined {
  const raw = JSON.parse(
    safeJsonStringify({
      llmContent: result.llmContent,
      returnDisplay: result.returnDisplay,
      data: result.data,
    }),
  ) as unknown;
  return (
    findStringProperty(raw, 'nextCursor') ??
    findStringProperty(raw, 'next_cursor')
  );
}

function findStringProperty(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringProperty(item, key);
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
  const direct = getString(record, key);
  if (direct) {
    return direct;
  }
  for (const child of Object.values(record)) {
    const found = findStringProperty(child, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function getSpanStableKey(span: Record<string, unknown>): string {
  const context = getRecord(span['context']);
  return (
    getString(context, 'span_id') ??
    getString(span, 'span_id') ??
    getString(span, 'id') ??
    safeJsonStringify(span)
  );
}

function extractEvidence(
  value: unknown,
  query: {
    call: ErroredToolCall;
    sessionId: string;
  },
): FailedToolEvidenceMatch | undefined {
  const raw = JSON.parse(safeJsonStringify(value)) as unknown;
  const best = findBestFailedToolSpan(raw, query);
  if (!best) {
    return undefined;
  }
  const { span, match } = best;
  const attributes = getRecord(span['attributes']);
  const previewValue = getString(attributes, GEMINI_CLI_OUTPUT_PREVIEW);
  const redactedPreview = previewValue
    ? redactSensitiveText(previewValue).value
    : undefined;

  return {
    evidence: {
      spanName: getString(span, 'name'),
      toolName: getString(attributes, GEN_AI_TOOL_NAME),
      exitCode: getNumber(attributes, GEMINI_CLI_COMMAND_EXIT_CODE),
      outputPreview: redactedPreview,
      outputSha256: getString(attributes, GEMINI_CLI_OUTPUT_SHA256),
    },
    reason: match.reason,
    timestamp: getSpanTimestamp(span),
    score: match.score,
  };
}

function extractHistoricalRepairEvidence(
  value: unknown,
  signature: TracePilotFailureSignature,
): PhoenixHistoricalRepairEvidence[] {
  const raw = JSON.parse(safeJsonStringify(value)) as unknown;
  const spans = collectSpanLikeObjects(raw);
  const evidence = spans
    .map((span) => toHistoricalRepairEvidence(span))
    .filter(
      (item): item is PhoenixHistoricalRepairEvidence =>
        item !== undefined &&
        isRelevantHistoricalRepairEvidence(item, signature),
    )
    .sort(
      (left, right) =>
        scoreHistoricalRepairEvidence(right, signature) -
          scoreHistoricalRepairEvidence(left, signature) ||
        (parseEvidenceTimestamp(right) ?? 0) -
          (parseEvidenceTimestamp(left) ?? 0),
    );

  const byStableKey = new Map<string, PhoenixHistoricalRepairEvidence>();
  for (const item of evidence) {
    const key =
      item.traceId ??
      item.spanId ??
      item.repairFingerprint ??
      item.signatureId ??
      safeJsonStringify(item);
    byStableKey.set(key, item);
  }
  return [...byStableKey.values()].slice(0, 10);
}

function scoreHistoricalRepairEvidence(
  evidence: PhoenixHistoricalRepairEvidence,
  signature: TracePilotFailureSignature,
): number {
  let score = 0;
  if (evidence.signatureId === signature.id) score += 80;
  if (
    signature.outputSha256 !== undefined &&
    evidence.outputSha256 === signature.outputSha256
  ) {
    score += 70;
  }
  if (evidence.rootCause === signature.taxonomy) score += 25;
  if (evidence.verificationPassed) score += 10;
  if (hasHistoricalRepairSecondarySignal(evidence, signature)) score += 15;
  return score;
}

function parseEvidenceTimestamp(
  evidence: PhoenixHistoricalRepairEvidence,
): number | undefined {
  if (!evidence.spanTimestamp) {
    return undefined;
  }
  const parsed = Date.parse(evidence.spanTimestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toHistoricalRepairEvidence(
  span: Record<string, unknown>,
): PhoenixHistoricalRepairEvidence | undefined {
  const attributes = getRecord(span['attributes']);
  if (!attributes) {
    return undefined;
  }
  const context = getRecord(span['context']);
  const outputPreview = getString(attributes, GEMINI_CLI_OUTPUT_PREVIEW);
  return {
    sessionId:
      getString(attributes, 'session.id') ??
      getString(attributes, 'gemini_cli.session.id') ??
      getString(attributes, 'gen_ai.conversation.id'),
    traceId: getString(context, 'trace_id') ?? getString(span, 'trace_id'),
    spanId: getString(context, 'span_id') ?? getString(span, 'span_id'),
    signatureId: getString(attributes, GEMINI_CLI_REPAIR_SIGNATURE_ID),
    repairFingerprint: getString(attributes, GEMINI_CLI_REPAIR_FINGERPRINT),
    rootCause: getString(attributes, GEMINI_CLI_REPAIR_ROOT_CAUSE),
    strategy: parseStrategy(getString(attributes, GEMINI_CLI_REPAIR_STRATEGY)),
    confidenceScore: getNumber(attributes, GEMINI_CLI_REPAIR_CONFIDENCE_SCORE),
    verificationPassed: getBoolean(
      attributes,
      GEMINI_CLI_REPAIR_VERIFICATION_PASSED,
    ),
    outputSha256: getString(attributes, GEMINI_CLI_OUTPUT_SHA256),
    outputPreview: outputPreview
      ? redactSensitiveText(outputPreview).value
      : undefined,
    spanTimestamp: getSpanTimestamp(span),
  };
}

function isRelevantHistoricalRepairEvidence(
  evidence: PhoenixHistoricalRepairEvidence,
  signature: TracePilotFailureSignature,
): boolean {
  if (evidence.signatureId !== undefined) {
    return evidence.signatureId === signature.id;
  }
  if (
    signature.outputSha256 !== undefined &&
    evidence.outputSha256 === signature.outputSha256
  ) {
    return true;
  }
  if (evidence.rootCause !== signature.taxonomy) {
    return false;
  }
  return hasHistoricalRepairSecondarySignal(evidence, signature);
}

function getHistoricalRepairEvidenceReason(
  evidence: PhoenixHistoricalRepairEvidence | undefined,
  signature: TracePilotFailureSignature,
): string | undefined {
  if (!evidence) {
    return undefined;
  }
  if (evidence.signatureId === signature.id) {
    return 'signature_id';
  }
  if (
    signature.outputSha256 !== undefined &&
    evidence.outputSha256 === signature.outputSha256
  ) {
    return 'output_sha256';
  }
  if (
    evidence.rootCause === signature.taxonomy &&
    hasHistoricalRepairSecondarySignal(evidence, signature)
  ) {
    return 'root_cause+secondary_signal';
  }
  return 'unknown';
}

function hasHistoricalRepairSecondarySignal(
  evidence: PhoenixHistoricalRepairEvidence,
  signature: TracePilotFailureSignature,
): boolean {
  const preview = normalizeHistoricalText(evidence.outputPreview);
  if (!preview) {
    return false;
  }
  const signatureSignals = [
    ...signature.diagnostics,
    ...signature.stackFrames,
    ...signature.files,
  ].map(normalizeHistoricalText);

  return signatureSignals.some((signal) => {
    if (!signal) {
      return false;
    }
    return preview.includes(signal) || tokenOverlap(preview, signal) >= 0.35;
  });
}

function normalizeHistoricalText(value: string | undefined): string {
  return redactSensitiveText(value ?? '')
    .value.toLowerCase()
    .replace(/\b[a-f0-9]{7,64}\b/g, '<hash>')
    .replace(/\b\d+:\d+\b/g, '<line:col>')
    .replace(/\bline\s+\d+\b/g, 'line <n>')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection++;
    }
  }
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function significantTokens(value: string): Set<string> {
  return new Set(
    value
      .split(/[^a-z0-9_./-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function parseStrategy(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Fall through to delimiter parsing for older spans.
  }
  return value
    .split(/\s*(?:\||,|\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findBestFailedToolSpan(
  value: unknown,
  query: {
    call: ErroredToolCall;
    sessionId: string;
  },
):
  | { span: Record<string, unknown>; match: FailedToolEvidenceMatchScore }
  | undefined {
  const candidates = collectSpanLikeObjects(value)
    .map((span) => ({
      span,
      match: scoreFailedToolSpan(span, query),
    }))
    .filter((item) => item.match.accepted)
    .sort((left, right) => {
      const scoreDelta = right.match.score - left.match.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return (
        (parseSpanTimestamp(right.span) ?? 0) -
        (parseSpanTimestamp(left.span) ?? 0)
      );
    });
  return candidates[0];
}

interface FailedToolEvidenceMatchScore {
  accepted: boolean;
  score: number;
  reason: string;
}

function scoreFailedToolSpan(
  span: Record<string, unknown>,
  query: {
    call: ErroredToolCall;
    sessionId: string;
  },
): FailedToolEvidenceMatchScore {
  const attributes = getRecord(span['attributes']);
  const sessionMatches = spanSessionMatches(span, query.sessionId);
  const missingSession = getSpanSessionId(attributes) === undefined;
  const toolMatches =
    getString(attributes, GEN_AI_TOOL_NAME) === query.call.request.name;
  const callIdMatches =
    getString(attributes, GEN_AI_TOOL_CALL_ID) === query.call.request.callId;
  const expectedExitCode = getExpectedExitCode(query.call);
  const spanExitCode = getNumber(attributes, GEMINI_CLI_COMMAND_EXIT_CODE);
  const failedExitCode = spanExitCode !== undefined && spanExitCode !== 0;
  const exitCodeMatches =
    expectedExitCode !== undefined
      ? spanExitCode === expectedExitCode
      : failedExitCode;
  const expectedOutputSha256 = getExpectedOutputSha256(query.call);
  const outputSha256Matches =
    expectedOutputSha256 !== undefined &&
    getString(attributes, GEMINI_CLI_OUTPUT_SHA256) === expectedOutputSha256;
  const timestampMatches = spanTimestampMatchesCall(span, query.call);
  const spanNameMatches = spanNameMatchesTool(span, query.call.request.name);

  let score = 0;
  if (sessionMatches) score += 30;
  if (toolMatches) score += 25;
  if (callIdMatches) score += 80;
  if (outputSha256Matches) score += 70;
  if (exitCodeMatches) score += expectedExitCode !== undefined ? 35 : 20;
  if (timestampMatches) score += 15;
  if (spanNameMatches) score += 10;

  const accepted =
    (callIdMatches || outputSha256Matches) &&
    !isConflictingSession(span, query.sessionId)
      ? true
      : (sessionMatches || missingSession) && toolMatches && failedExitCode;
  return {
    accepted,
    score,
    reason: getFailedToolEvidenceReason({
      callIdMatches,
      outputSha256Matches,
      sessionMatches,
      toolMatches,
      exitCodeMatches,
      timestampMatches,
      spanNameMatches,
    }),
  };
}

function getFailedToolEvidenceReason(signals: {
  callIdMatches: boolean;
  outputSha256Matches: boolean;
  sessionMatches: boolean;
  toolMatches: boolean;
  exitCodeMatches: boolean;
  timestampMatches: boolean;
  spanNameMatches: boolean;
}): string {
  const reasons = [
    signals.callIdMatches ? 'call_id' : undefined,
    signals.outputSha256Matches ? 'output_sha256' : undefined,
    signals.sessionMatches ? 'session' : undefined,
    signals.toolMatches ? 'tool_name' : undefined,
    signals.exitCodeMatches ? 'failed_exit_code' : undefined,
    signals.timestampMatches ? 'timestamp' : undefined,
    signals.spanNameMatches ? 'span_name' : undefined,
  ].filter((item): item is string => item !== undefined);
  return reasons.length > 0 ? reasons.join('+') : 'no_strong_match';
}

function spanSessionMatches(
  span: Record<string, unknown>,
  sessionId: string,
): boolean {
  const attributes = getRecord(span['attributes']);
  return getSpanSessionId(attributes) === sessionId;
}

function isConflictingSession(
  span: Record<string, unknown>,
  sessionId: string,
): boolean {
  const attributes = getRecord(span['attributes']);
  const spanSessionId = getSpanSessionId(attributes);
  return spanSessionId !== undefined && spanSessionId !== sessionId;
}

function getSpanSessionId(
  attributes: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getString(attributes, 'session.id') ??
    getString(attributes, 'gemini_cli.session.id') ??
    getString(attributes, GEN_AI_CONVERSATION_ID)
  );
}

function getExpectedExitCode(call: ErroredToolCall): number | undefined {
  const data = getRecord(call.response.data);
  return getNumber(data, 'exitCode') ?? getNumber(data, 'exit_code');
}

function getExpectedOutputSha256(call: ErroredToolCall): string | undefined {
  const data = getRecord(call.response.data);
  return (
    getString(data, 'outputSha256') ??
    getString(data, 'output_sha256') ??
    getString(data, GEMINI_CLI_OUTPUT_SHA256)
  );
}

function spanTimestampMatchesCall(
  span: Record<string, unknown>,
  call: ErroredToolCall,
): boolean {
  if (call.startTime === undefined && call.endTime === undefined) {
    return false;
  }
  const timestamp = parseSpanTimestamp(span);
  if (timestamp === undefined) {
    return false;
  }
  const start = (call.startTime ?? timestamp) - TOOL_CALL_TIME_BUFFER_MS;
  const end = (call.endTime ?? timestamp) + TOOL_CALL_TIME_BUFFER_MS;
  return timestamp >= start && timestamp <= end;
}

function spanNameMatchesTool(
  span: Record<string, unknown>,
  failedToolName: string,
): boolean {
  const spanName = getString(span, 'name');
  if (failedToolName === SHELL_TOOL_NAME) {
    return spanName === GeminiCliOperation.ToolShell;
  }
  return Boolean(spanName?.startsWith('gemini_cli.tool.'));
}

function getSpanTimestamp(span: Record<string, unknown>): string | undefined {
  return (
    getString(span, 'start_time') ??
    getString(span, 'startTime') ??
    getString(span, 'timestamp') ??
    getString(span, 'event.timestamp')
  );
}

function parseSpanTimestamp(span: Record<string, unknown>): number | undefined {
  const timestamp = getSpanTimestamp(span);
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}
