/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const PHOENIX_COLLECTOR_ENV_MISSING_REASON =
  'missing PHOENIX_API_KEY plus PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_BASE_URL';
export const PHOENIX_MCP_ENV_MISSING_REASON =
  'missing PHOENIX_API_KEY, PHOENIX_PROJECT, or a real Phoenix host/base/collector URL';

export interface TracePilotPhoenixEnv {
  apiKey?: string;
  project?: string;
  host?: string;
  baseUrl?: string;
  collectorEndpoint?: string;
  normalizedHost?: string;
  collectorReady: boolean;
  mcpReady: boolean;
  collectorSkipReason?: string;
  mcpSkipReason?: string;
}

export function resolveTracePilotPhoenixEnv(
  env: NodeJS.ProcessEnv,
): TracePilotPhoenixEnv {
  const apiKey = nonEmpty(env['PHOENIX_API_KEY']);
  const project = nonEmpty(env['PHOENIX_PROJECT']);
  const host = nonEmpty(env['PHOENIX_HOST']);
  const baseUrl = nonEmpty(env['PHOENIX_BASE_URL']);
  const collectorEndpoint = nonEmpty(env['PHOENIX_COLLECTOR_ENDPOINT']);
  const normalizedHost = resolvePhoenixHostFromEnv(env);
  const collectorReady = Boolean(apiKey && (collectorEndpoint || baseUrl));
  const mcpReady = Boolean(collectorReady && project && normalizedHost);

  return {
    apiKey,
    project,
    host,
    baseUrl,
    collectorEndpoint,
    normalizedHost,
    collectorReady,
    mcpReady,
    collectorSkipReason: collectorReady
      ? undefined
      : PHOENIX_COLLECTOR_ENV_MISSING_REASON,
    mcpSkipReason: mcpReady ? undefined : PHOENIX_MCP_ENV_MISSING_REASON,
  };
}

export function resolvePhoenixHostFromEnv(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return [
    env['PHOENIX_HOST'],
    env['PHOENIX_BASE_URL'],
    env['PHOENIX_COLLECTOR_ENDPOINT'],
  ]
    .map(normalizePhoenixUrl)
    .find((value): value is string => value !== undefined);
}

export function normalizePhoenixUrl(
  value: string | undefined,
): string | undefined {
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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
