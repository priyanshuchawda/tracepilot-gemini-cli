/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  resolvePhoenixHostFromEnv,
  resolveTracePilotPhoenixEnv,
} from './phoenixEnv.js';

export {
  PHOENIX_COLLECTOR_ENV_MISSING_REASON,
  PHOENIX_MCP_ENV_MISSING_REASON,
  normalizePhoenixUrl,
  resolveTracePilotPhoenixEnv,
} from './phoenixEnv.js';

export const PHOENIX_MCP_TOOL_NAME = 'get-spans';
export const DEFAULT_PHOENIX_MCP_PACKAGE = '@arizeai/phoenix-mcp@4.0.13';
export const PHOENIX_MCP_PACKAGE_ENV = 'TRACEPILOT_PHOENIX_MCP_PACKAGE';
export const DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS = 180_000;
export const DIRECT_PHOENIX_MCP_SERVER_NAME = 'tracepilot-phoenix-env';

export interface PhoenixMcpToolResult {
  llmContent?: unknown;
  returnDisplay?: unknown;
  data?: unknown;
  error?: { message: string };
}

export interface DirectPhoenixMcpConfig {
  host: string;
  project: string;
  apiKey: string;
}

export interface DirectPhoenixMcpClient {
  listTools: () => Promise<string[]>;
  callGetSpans: (
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<PhoenixMcpToolResult>;
  close: () => Promise<void>;
}

export function resolveDirectPhoenixMcpConfig(
  env: NodeJS.ProcessEnv,
): DirectPhoenixMcpConfig | undefined {
  const phoenixEnv = resolveTracePilotPhoenixEnv(env);
  if (!phoenixEnv.apiKey || !phoenixEnv.project || !phoenixEnv.normalizedHost) {
    return undefined;
  }
  return {
    apiKey: phoenixEnv.apiKey,
    project: phoenixEnv.project,
    host: phoenixEnv.normalizedHost,
  };
}

export function resolvePhoenixMcpHost(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return resolvePhoenixHostFromEnv(env);
}

export function resolvePhoenixMcpPackage(env: NodeJS.ProcessEnv): string {
  return env[PHOENIX_MCP_PACKAGE_ENV]?.trim() || DEFAULT_PHOENIX_MCP_PACKAGE;
}

export async function callDirectPhoenixMcpGetSpans(
  args: Record<string, unknown>,
  directConfig: DirectPhoenixMcpConfig,
  options: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    clientName?: string;
  } = {},
): Promise<PhoenixMcpToolResult> {
  const client = await connectDirectPhoenixMcpClient(directConfig, options);
  try {
    return await client.callGetSpans(args, options.timeoutMs);
  } finally {
    await client.close();
  }
}

export async function connectDirectPhoenixMcpClient(
  directConfig: DirectPhoenixMcpConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    clientName?: string;
  } = {},
): Promise<DirectPhoenixMcpClient> {
  const env = options.env ?? process.env;
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', resolvePhoenixMcpPackage(env)],
    env: {
      ...env,
      PHOENIX_API_KEY: directConfig.apiKey,
      PHOENIX_HOST: directConfig.host,
      PHOENIX_PROJECT: directConfig.project,
    },
  });
  const client = new Client({
    name: options.clientName ?? 'tracepilot-phoenix-mcp',
    version: '0.0.0',
  });

  await client.connect(transport);
  return {
    listTools: async () => {
      const listed = await client.listTools();
      return getSpanList(getRecord(listed)?.['tools']).flatMap((tool) => {
        const name = getString(tool, 'name');
        return name ? [name] : [];
      });
    },
    callGetSpans: async (
      args,
      timeoutMs = DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS,
    ) => {
      const result = await client.callTool(
        {
          name: PHOENIX_MCP_TOOL_NAME,
          arguments: args,
        },
        undefined,
        { timeout: timeoutMs },
      );
      return toPhoenixMcpToolResult(result);
    },
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

export function toPhoenixMcpToolResult(result: unknown): PhoenixMcpToolResult {
  const record = getRecord(result);
  const text = getTextContent(result);
  if (record?.['isError']) {
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
}

export function getTextContent(result: unknown): string {
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

export function parseJsonText(text: string): unknown {
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

export function getSpanList(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  const record = getRecord(payload);
  if (!record) {
    return [];
  }
  const spans = record['spans'] ?? record['data'];
  return Array.isArray(spans) ? spans.filter(isRecord) : [];
}

export function collectSpanLikeObjects(
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

export async function withPhoenixMcpTimeout<T>(
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

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function getBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function getStringList(
  record: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
