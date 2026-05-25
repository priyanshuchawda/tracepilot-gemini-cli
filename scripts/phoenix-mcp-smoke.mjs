#!/usr/bin/env node
import dotenv from 'dotenv';

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

async function loadPhoenixMcpUtils() {
  try {
    return await import(
      '../packages/core/dist/src/telemetry/phoenixMcpUtils.js'
    );
  } catch (error) {
    fail(
      `Could not load packages/core/dist/src/telemetry/phoenixMcpUtils.js. Run \`npm run build -w @google/gemini-cli-core\` first. ${error?.message ?? error}`,
    );
  }
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
        operation: GeminiCliOperation.AgentTurn,
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

async function querySmokeSpan(sessionId, phoenixMcp, directConfig) {
  const client = await phoenixMcp.connectDirectPhoenixMcpClient(directConfig, {
    clientName: 'tracepilot-phoenix-mcp-smoke',
  });

  try {
    const toolNames = await client.listTools();
    if (!toolNames.includes('get-spans')) {
      fail('Phoenix MCP connected but did not expose get-spans.');
    }

    const startTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    let lastError = '';
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = await client.callGetSpans(
        {
          project_identifier: directConfig.project,
          start_time: startTime,
          names: ['gemini_cli.agent_turn'],
          limit: 100,
        },
        phoenixMcp.DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS,
      );

      if (result.error) {
        lastError = result.error.message || 'get-spans returned an MCP error';
      } else {
        const spans = phoenixMcp.getSpanList(result.data ?? result.llmContent);
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
    await client.close();
  }
}

const phoenixMcp = await loadPhoenixMcpUtils();
assertPhoenixEnv();
const directConfig = phoenixMcp.resolveDirectPhoenixMcpConfig(process.env);
if (!directConfig) {
  fail(
    'Missing Phoenix MCP connection env. Set PHOENIX_API_KEY, PHOENIX_PROJECT, and PHOENIX_HOST, PHOENIX_BASE_URL, or PHOENIX_COLLECTOR_ENDPOINT.',
    2,
  );
}
const sessionId = `tracepilot-mcp-smoke-${Date.now()}`;

await createSmokeSpan(sessionId);
const evidence = await querySmokeSpan(sessionId, phoenixMcp, directConfig);

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
