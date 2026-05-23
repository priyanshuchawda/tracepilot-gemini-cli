/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from '../config/config.js';
import type { ErroredToolCall } from '../scheduler/types.js';
import { MCPServerStatus, type McpClient } from '../tools/mcp-client.js';
import type { McpClientManager } from '../tools/mcp-client-manager.js';
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
  GEN_AI_TOOL_NAME,
} from './constants.js';
import type { TracePilotFailureSignature } from '../tracepilot/failureSignature.js';
import { redactSensitiveText } from './sanitize.js';
import { flushTelemetry } from './sdk.js';
import { runInDevTraceSpan } from './trace.js';

const PHOENIX_MCP_TOOL_NAME = 'get-spans';
const DEFAULT_TIMEOUT_MS = 20000;
const DIRECT_PHOENIX_MCP_SERVER_NAME = 'tracepilot-phoenix-env';
const DEFAULT_PHOENIX_MCP_PACKAGE = '@arizeai/phoenix-mcp@4.0.13';
const PHOENIX_MCP_PACKAGE_ENV = 'TRACEPILOT_PHOENIX_MCP_PACKAGE';

interface PhoenixMcpToolResult {
  llmContent?: unknown;
  returnDisplay?: unknown;
  data?: unknown;
  error?: { message: string };
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
}

export type PhoenixHistoricalRepairQueryResult =
  | {
      attempted: false;
      available: false;
      reason: string;
      evidence: [];
    }
  | {
      attempted: true;
      available: false;
      reason: string;
      evidence: [];
    }
  | {
      attempted: true;
      available: true;
      evidence: PhoenixHistoricalRepairEvidence[];
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

      const args = buildPhoenixGetSpansArgs(config.getSessionId());
      const phoenixQuery = getPhoenixMcpQuery(config, args);
      if (!phoenixQuery) {
        const result: PhoenixSelfIntrospectionResult = {
          attempted: false,
          available: false,
          reason:
            'Phoenix MCP client unavailable or PHOENIX_API_KEY/PHOENIX_PROJECT/Phoenix host env is missing.',
        };
        metadata.output = result;
        return result;
      }

      try {
        const controller = new AbortController();
        const toolResult = await runInDevTraceSpan(
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

            const result = await withTimeout(
              phoenixQuery.execute(controller.signal),
              timeoutMs,
              () => controller.abort(),
            );

            if (result.error) {
              metadata.error = result.error;
              metadata.output = {
                status: 'error',
                message: result.error.message,
              };
            } else {
              metadata.output = { status: 'ok' };
            }
            return result;
          },
        );
        if (toolResult.error) {
          throw new Error(toolResult.error.message);
        }
        const evidence = extractEvidence(
          {
            llmContent: toolResult.llmContent,
            returnDisplay: toolResult.returnDisplay,
            data: toolResult.data,
          },
          call.request.name,
        );
        if (!evidence) {
          const result: PhoenixSelfIntrospectionResult = {
            attempted: true,
            available: false,
            reason: `Phoenix MCP did not return matching failed span evidence for ${call.request.name}.`,
          };
          metadata.output = result;
          return result;
        }
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
      reason: `Phoenix telemetry flush failed before historical repair query: ${getErrorMessage(
        error,
      )}`,
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
      const phoenixQuery = getPhoenixMcpQuery(config, args);
      if (!phoenixQuery) {
        const result: PhoenixHistoricalRepairQueryResult = {
          attempted: false,
          available: false,
          reason:
            'Phoenix MCP client unavailable or PHOENIX_API_KEY/PHOENIX_PROJECT/Phoenix host env is missing.',
          evidence: [],
        };
        metadata.output = result;
        return result;
      }

      try {
        const controller = new AbortController();
        const toolResult = await runInDevTraceSpan(
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

            const result = await withTimeout(
              phoenixQuery.execute(controller.signal),
              timeoutMs,
              () => controller.abort(),
            );

            if (result.error) {
              metadata.error = result.error;
              metadata.output = {
                status: 'error',
                message: result.error.message,
              };
            } else {
              metadata.output = { status: 'ok' };
            }
            return result;
          },
        );
        if (toolResult.error) {
          throw new Error(toolResult.error.message);
        }
        const evidence = extractHistoricalRepairEvidence(
          {
            llmContent: toolResult.llmContent,
            returnDisplay: toolResult.returnDisplay,
            data: toolResult.data,
          },
          signature,
        );
        const result: PhoenixHistoricalRepairQueryResult =
          evidence.length > 0
            ? {
                attempted: true,
                available: true,
                evidence,
              }
            : {
                attempted: true,
                available: false,
                reason: `Phoenix MCP returned no historical repair spans matching ${signature.id}.`,
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
        const result: PhoenixHistoricalRepairQueryResult = {
          attempted: true,
          available: false,
          reason: `Phoenix historical repair query failed: ${getErrorMessage(
            error,
          )}`,
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
  args: Record<string, unknown>,
):
  | {
      serverName: string;
      execute: (signal: AbortSignal) => Promise<PhoenixMcpToolResult>;
    }
  | undefined {
  const manager = config.getMcpClientManager();
  const clientInfo = findPhoenixMcpClient(manager);
  if (clientInfo) {
    const phoenixTool = findPhoenixGetSpansTool(config, clientInfo.serverName);
    if (phoenixTool) {
      return {
        serverName: clientInfo.serverName,
        execute: (signal) => phoenixTool.buildAndExecute(args, signal),
      };
    }
  }

  const directConfig = resolveDirectPhoenixMcpConfig(process.env);
  if (!directConfig) {
    return undefined;
  }

  return {
    serverName: DIRECT_PHOENIX_MCP_SERVER_NAME,
    execute: () => callDirectPhoenixMcpGetSpans(args, directConfig),
  };
}

interface DirectPhoenixMcpConfig {
  host: string;
  project: string;
  apiKey: string;
}

function resolveDirectPhoenixMcpConfig(
  env: NodeJS.ProcessEnv,
): DirectPhoenixMcpConfig | undefined {
  const apiKey = env['PHOENIX_API_KEY']?.trim();
  const project = env['PHOENIX_PROJECT']?.trim();
  const host = resolvePhoenixMcpHost(env);
  if (!apiKey || !project || !host) {
    return undefined;
  }
  return { apiKey, project, host };
}

async function callDirectPhoenixMcpGetSpans(
  args: Record<string, unknown>,
  directConfig: DirectPhoenixMcpConfig,
): Promise<PhoenixMcpToolResult> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', resolvePhoenixMcpPackage(process.env)],
    env: {
      ...process.env,
      PHOENIX_API_KEY: directConfig.apiKey,
      PHOENIX_HOST: directConfig.host,
      PHOENIX_PROJECT: directConfig.project,
    },
  });
  const client = new Client({
    name: 'tracepilot-phoenix-self-introspection',
    version: '0.0.0',
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: PHOENIX_MCP_TOOL_NAME,
      arguments: args,
    });
    const text = getTextContent(result);
    if (result.isError) {
      return {
        error: {
          message: text || 'Phoenix MCP get-spans returned an error.',
        },
      };
    }
    const parsed = parseJsonText(text);
    return {
      llmContent: parsed ?? text,
      returnDisplay: '',
      data: parsed,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
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

function buildPhoenixHistoricalRepairArgs(
  signature: TracePilotFailureSignature,
): Record<string, unknown> {
  const startTime = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const args: Record<string, unknown> = {
    start_time: startTime,
    names: [
      GeminiCliOperation.RepairPlan,
      GeminiCliOperation.RepairReport,
      GeminiCliOperation.RepairEval,
      GeminiCliOperation.RepairVerify,
      GeminiCliOperation.ToolShell,
    ],
    limit: 100,
  };
  if (process.env['PHOENIX_PROJECT']) {
    args['project_identifier'] = process.env['PHOENIX_PROJECT'];
  }
  // Phoenix MCP versions vary in filter support; this query remains broad and
  // filtering is deterministic client-side.
  args['query'] =
    `${signature.id} ${signature.taxonomy} ${signature.outputSha256 ?? ''}`.trim();
  return args;
}

function resolvePhoenixMcpHost(env: NodeJS.ProcessEnv): string | undefined {
  return [
    env['PHOENIX_HOST'],
    env['PHOENIX_BASE_URL'],
    env['PHOENIX_COLLECTOR_ENDPOINT'],
  ]
    .map(normalizePhoenixUrl)
    .find((value): value is string => value !== undefined);
}

function normalizePhoenixUrl(value: string | undefined): string | undefined {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed || /YOUR_|your-|example/i.test(trimmed)) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/v1\/traces$/i, '')
      .replace(/\/v1$/i, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function resolvePhoenixMcpPackage(env: NodeJS.ProcessEnv): string {
  return env[PHOENIX_MCP_PACKAGE_ENV]?.trim() || DEFAULT_PHOENIX_MCP_PACKAGE;
}

function getTextContent(result: unknown): string {
  const record = getRecord(result);
  const content = Array.isArray(record?.['content']) ? record['content'] : [];
  return content
    .map((part) => getRecord(part))
    .filter(
      (part): part is Record<string, unknown> => part?.['type'] === 'text',
    )
    .map((part) => getString(part, 'text') ?? '')
    .join('\n');
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
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

function extractEvidence(
  value: unknown,
  failedToolName?: string,
): PhoenixTraceEvidence | undefined {
  const raw = JSON.parse(safeJsonStringify(value)) as unknown;
  const span = findBestSpanLikeObject(raw, failedToolName);
  if (!span) {
    return undefined;
  }
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
  };
}

function isRelevantHistoricalRepairEvidence(
  evidence: PhoenixHistoricalRepairEvidence,
  signature: TracePilotFailureSignature,
): boolean {
  return (
    evidence.signatureId === signature.id ||
    evidence.rootCause === signature.taxonomy ||
    (signature.outputSha256 !== undefined &&
      evidence.outputSha256 === signature.outputSha256) ||
    evidence.verificationPassed === true
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

function findBestSpanLikeObject(
  value: unknown,
  failedToolName?: string,
): Record<string, unknown> | undefined {
  const spans = collectSpanLikeObjects(value);
  return (
    spans.find((span) => isMatchingFailedSpan(span, failedToolName)) ??
    spans.find((span) => isMatchingToolSpan(span, failedToolName)) ??
    spans.find(isFailedSpan) ??
    spans[0]
  );
}

function collectSpanLikeObjects(
  value: unknown,
  found: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSpanLikeObjects(item, found);
    }
    return found;
  }
  const record = getRecord(value);
  if (!record) {
    return found;
  }
  if (getString(record, 'name') && getRecord(record['attributes'])) {
    found.push(record);
    return found;
  }
  for (const child of Object.values(record)) {
    collectSpanLikeObjects(child, found);
  }
  return found;
}

function isMatchingFailedSpan(
  span: Record<string, unknown>,
  failedToolName: string | undefined,
): boolean {
  return isMatchingToolSpan(span, failedToolName) && isFailedSpan(span);
}

function isMatchingToolSpan(
  span: Record<string, unknown>,
  failedToolName: string | undefined,
): boolean {
  if (!failedToolName) {
    return false;
  }
  const attributes = getRecord(span['attributes']);
  return getString(attributes, GEN_AI_TOOL_NAME) === failedToolName;
}

function isFailedSpan(span: Record<string, unknown>): boolean {
  const attributes = getRecord(span['attributes']);
  const exitCode = getNumber(attributes, GEMINI_CLI_COMMAND_EXIT_CODE);
  return exitCode !== undefined && exitCode !== 0;
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

function getBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}
