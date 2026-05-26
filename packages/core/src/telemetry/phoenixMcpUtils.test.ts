/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callDirectPhoenixMcpGetSpans,
  collectSpanLikeObjects,
  getSpanList,
  normalizePhoenixUrl,
  parseJsonText,
  resolveDirectPhoenixMcpConfig,
  resolveTracePilotPhoenixEnv,
  resolvePhoenixMcpPackage,
  withPhoenixMcpTimeout,
} from './phoenixMcpUtils.js';

const mcpClient = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  callTool: vi.fn(),
  listTools: vi.fn(),
}));
const stdioTransport = vi.hoisted(() => vi.fn((options) => ({ options })));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => mcpClient),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: stdioTransport,
}));

describe('phoenix MCP utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpClient.close.mockResolvedValue(undefined);
    mcpClient.connect.mockResolvedValue(undefined);
    mcpClient.callTool.mockReset();
    mcpClient.listTools.mockReset();
  });

  it('normalizes Phoenix Cloud collector URLs to MCP hosts', () => {
    expect(
      normalizePhoenixUrl(
        'https://app.phoenix.arize.com/s/demo/v1/traces?ignored=true#hash',
      ),
    ).toBe('https://app.phoenix.arize.com/s/demo');
    expect(normalizePhoenixUrl('https://app.phoenix.arize.com/s/demo/v1')).toBe(
      'https://app.phoenix.arize.com/s/demo',
    );
    expect(normalizePhoenixUrl('https://app.phoenix.arize.com/s/demo///')).toBe(
      'https://app.phoenix.arize.com/s/demo',
    );
    expect(normalizePhoenixUrl('YOUR_PHOENIX_HOST')).toBeUndefined();
    expect(
      normalizePhoenixUrl('https://app.phoenix.arize.com/s/YOUR_SPACE'),
    ).toBeUndefined();
    expect(normalizePhoenixUrl('https://example.com/s/demo')).toBeUndefined();
    expect(normalizePhoenixUrl('not a url')).toBeUndefined();
  });

  it('resolves Phoenix env readiness consistently for collector and MCP use', () => {
    expect(
      resolveTracePilotPhoenixEnv({
        PHOENIX_API_KEY: 'phx_key',
        PHOENIX_PROJECT: 'tracepilot',
        PHOENIX_HOST: 'https://app.phoenix.arize.com/s/host-space/',
        PHOENIX_BASE_URL: 'https://app.phoenix.arize.com/s/base-space',
        PHOENIX_COLLECTOR_ENDPOINT:
          'https://app.phoenix.arize.com/s/collector-space/v1/traces',
      }),
    ).toMatchObject({
      collectorReady: true,
      mcpReady: true,
      normalizedHost: 'https://app.phoenix.arize.com/s/host-space',
    });

    expect(
      resolveTracePilotPhoenixEnv({
        PHOENIX_API_KEY: 'phx_key',
        PHOENIX_PROJECT: 'tracepilot',
        PHOENIX_BASE_URL: 'https://app.phoenix.arize.com/s/base-space/',
      }),
    ).toMatchObject({
      collectorReady: true,
      mcpReady: true,
      normalizedHost: 'https://app.phoenix.arize.com/s/base-space',
    });

    expect(
      resolveTracePilotPhoenixEnv({
        PHOENIX_API_KEY: 'phx_key',
        PHOENIX_PROJECT: 'tracepilot',
        PHOENIX_COLLECTOR_ENDPOINT:
          'https://app.phoenix.arize.com/s/collector-space/v1/traces',
      }),
    ).toMatchObject({
      collectorReady: true,
      mcpReady: true,
      normalizedHost: 'https://app.phoenix.arize.com/s/collector-space',
    });

    expect(resolveTracePilotPhoenixEnv({})).toMatchObject({
      collectorReady: false,
      mcpReady: false,
      collectorSkipReason:
        'missing PHOENIX_API_KEY plus PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_BASE_URL',
      mcpSkipReason:
        'missing PHOENIX_API_KEY, PHOENIX_PROJECT, or a real Phoenix host/base/collector URL',
    });

    expect(
      resolveTracePilotPhoenixEnv({
        PHOENIX_API_KEY: 'phx_key',
        PHOENIX_PROJECT: 'tracepilot',
        PHOENIX_BASE_URL: 'https://app.phoenix.arize.com/s/YOUR_SPACE',
      }),
    ).toMatchObject({
      collectorReady: true,
      mcpReady: false,
      normalizedHost: undefined,
    });
  });

  it('resolves direct config and package overrides from env', () => {
    const env = {
      PHOENIX_API_KEY: 'phx_key',
      PHOENIX_PROJECT: 'tracepilot',
      PHOENIX_COLLECTOR_ENDPOINT:
        'https://app.phoenix.arize.com/s/demo/v1/traces',
      TRACEPILOT_PHOENIX_MCP_PACKAGE: '@arizeai/phoenix-mcp@4.0.12',
    };

    expect(resolveDirectPhoenixMcpConfig(env)).toEqual({
      apiKey: 'phx_key',
      host: 'https://app.phoenix.arize.com/s/demo',
      project: 'tracepilot',
    });
    expect(resolvePhoenixMcpPackage(env)).toBe('@arizeai/phoenix-mcp@4.0.12');
  });

  it('parses JSON text with fallback and safely rejects malformed fallback JSON', () => {
    expect(parseJsonText('prefix {"spans": []} suffix')).toEqual({
      spans: [],
    });
    expect(parseJsonText('prefix {"spans": [} suffix')).toBeUndefined();
  });

  it('extracts span lists and nested span-like objects once', () => {
    const span = { name: 'gemini_cli.tool.shell', attributes: {} };

    expect(getSpanList({ spans: [span, null] })).toEqual([span]);
    expect(getSpanList({ data: [span] })).toEqual([span]);
    expect(getSpanList([span])).toEqual([span]);
    expect(collectSpanLikeObjects({ outer: { inner: [span] } })).toEqual([
      span,
    ]);
  });

  it('returns structured MCP tool errors from direct get-spans calls', async () => {
    mcpClient.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'Phoenix unavailable' }],
    });

    const result = await callDirectPhoenixMcpGetSpans(
      { limit: 1 },
      {
        apiKey: 'phx_key',
        host: 'https://app.phoenix.arize.com/s/demo',
        project: 'tracepilot',
      },
      {
        env: {
          TRACEPILOT_PHOENIX_MCP_PACKAGE: '@arizeai/phoenix-mcp@4.0.12',
        },
        timeoutMs: 123,
      },
    );

    expect(result).toEqual({ error: { message: 'Phoenix unavailable' } });
    expect(stdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npx',
        args: ['-y', '@arizeai/phoenix-mcp@4.0.12'],
        env: expect.objectContaining({
          PHOENIX_API_KEY: 'phx_key',
          PHOENIX_HOST: 'https://app.phoenix.arize.com/s/demo',
          PHOENIX_PROJECT: 'tracepilot',
        }),
      }),
    );
    expect(mcpClient.callTool).toHaveBeenCalledWith(
      { name: 'get-spans', arguments: { limit: 1 } },
      undefined,
      { timeout: 123 },
    );
    expect(mcpClient.close).toHaveBeenCalled();
  });

  it('times out Phoenix MCP calls and invokes abort hooks', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const promise = withPhoenixMcpTimeout(
      new Promise(() => undefined),
      25,
      onTimeout,
    );
    const observedError = promise.catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(25);
      const error = await observedError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Phoenix MCP query timed out');
      expect(onTimeout).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
