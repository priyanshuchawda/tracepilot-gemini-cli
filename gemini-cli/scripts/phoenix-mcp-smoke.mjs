#!/usr/bin/env node
import dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

dotenv.config({ quiet: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const secretValues = [
  process.env.PHOENIX_API_KEY,
  process.env.GEMINI_API_KEY,
].filter((value) => value && value.length >= 8);

function redactKnownSecrets(value) {
  let text = String(value ?? '');
  for (const secret of secretValues) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]');
}

function fail(message, code = 1) {
  console.error(redactKnownSecrets(message));
  process.exit(code);
}

function resolvePhoenixHost() {
  const host = (process.env.PHOENIX_HOST || process.env.PHOENIX_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');

  if (!host) {
    fail(
      'Missing Phoenix MCP host. Set PHOENIX_HOST to your Phoenix base URL.',
      2,
    );
  }
  if (/YOUR_|your-|example/i.test(host)) {
    fail(
      'Phoenix MCP host still contains a placeholder. Set PHOENIX_HOST to your real Phoenix base URL.',
      2,
    );
  }
  try {
    new URL(host);
  } catch {
    fail('Phoenix MCP host must be a valid absolute URL.', 2);
  }
  return host;
}

function assertPhoenixEnv() {
  if (!process.env.PHOENIX_API_KEY) {
    fail('Missing PHOENIX_API_KEY for Phoenix MCP smoke.', 2);
  }
  if (!process.env.PHOENIX_PROJECT) {
    fail('Missing PHOENIX_PROJECT for Phoenix MCP smoke.', 2);
  }
  if (
    !process.env.PHOENIX_COLLECTOR_ENDPOINT &&
    !process.env.PHOENIX_BASE_URL
  ) {
    fail(
      'Missing Phoenix collector configuration. Set PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_BASE_URL.',
      2,
    );
  }
}

function getTextContent(result) {
  return (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function getSpanList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.spans)) return payload.spans;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function createSmokeSpan(sessionId) {
  let core;
  try {
    core = await import('../packages/core/dist/index.js');
  } catch (error) {
    fail(
      `Could not load packages/core/dist/index.js. Run \`npm run build -w @google/gemini-cli-core\` first. ${error?.message ?? error}`,
    );
  }

  const {
    GeminiCliOperation,
    initializeTelemetry,
    flushTelemetry,
    runInDevTraceSpan,
    shutdownTelemetry,
  } = core;

  const config = {
    getTelemetryEnabled: () => true,
    getTelemetryOtlpEndpoint: () => 'http://localhost:4317',
    getTelemetryOtlpProtocol: () => 'grpc',
    getTelemetryTarget: () => 'local',
    getTelemetryUseCollector: () => false,
    getTelemetryOutfile: () => undefined,
    getTelemetryUseCliAuth: () => false,
    getDebugMode: () => true,
    getSessionId: () => sessionId,
    isInteractive: () => false,
    getExperiments: () => undefined,
    getExperimentsAsync: async () => undefined,
    getContentGeneratorConfig: () => undefined,
  };

  try {
    await initializeTelemetry(config);
    await runInDevTraceSpan(
      {
        operation: GeminiCliOperation.AgentCall,
        sessionId,
        tracesEnabled: true,
        logPrompts: true,
      },
      async ({ metadata }) => {
        metadata.input = {
          smoke: true,
          source: 'scripts/phoenix-mcp-smoke.mjs',
        };
        metadata.output = { status: 'ok' };
        metadata.attributes['tracepilot.smoke_test'] = true;
        metadata.attributes['tracepilot.smoke_session'] = sessionId;
        metadata.attributes['tracepilot.integration_path'] =
          'phoenix_mcp_visibility';
        return 'ok';
      },
    );

    await flushTelemetry(config);
  } finally {
    await shutdownTelemetry(config, false);
  }
}

async function querySmokeSpan(sessionId, host) {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@arizeai/phoenix-mcp@latest'],
    env: {
      ...process.env,
      PHOENIX_HOST: host,
      PHOENIX_PROJECT: process.env.PHOENIX_PROJECT,
    },
  });
  const client = new Client({
    name: 'tracepilot-phoenix-mcp-smoke',
    version: '0.0.0',
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (!toolNames.includes('get-spans')) {
      fail('Phoenix MCP connected but did not expose get-spans.');
    }

    const startTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    let lastError = '';
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = await client.callTool({
        name: 'get-spans',
        arguments: {
          project_identifier: process.env.PHOENIX_PROJECT,
          start_time: startTime,
          names: ['agent_call'],
          limit: 100,
        },
      });

      const text = getTextContent(result);
      if (result.isError) {
        lastError = text || 'get-spans returned an MCP error';
      } else {
        const payload = parseJsonText(text);
        const spans = getSpanList(payload);
        const smokeSpan = spans.find((span) => {
          const attributes = span.attributes ?? {};
          return (
            attributes['tracepilot.smoke_session'] === sessionId ||
            attributes['session.id'] === sessionId
          );
        });

        if (smokeSpan) {
          return {
            toolCount: toolNames.length,
            spanName: smokeSpan.name,
            traceId: smokeSpan.context?.trace_id ?? smokeSpan.trace_id ?? null,
            spanId: smokeSpan.context?.span_id ?? smokeSpan.span_id ?? null,
          };
        }
        lastError = `smoke span not visible yet; parsed ${spans.length} candidate spans`;
      }

      if (attempt < 8) await sleep(5000);
    }

    fail(`Phoenix MCP query did not find the smoke span: ${lastError}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

assertPhoenixEnv();
const host = resolvePhoenixHost();
const sessionId = `tracepilot-mcp-smoke-${Date.now()}`;

await createSmokeSpan(sessionId);
const evidence = await querySmokeSpan(sessionId, host);

console.log(
  JSON.stringify(
    {
      ok: true,
      phoenix_mcp_visible: true,
      project: process.env.PHOENIX_PROJECT,
      sessionId,
      ...evidence,
    },
    null,
    2,
  ),
);
