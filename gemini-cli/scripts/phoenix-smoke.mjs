#!/usr/bin/env node
import dotenv from 'dotenv';

dotenv.config();

const hasPhoenixEndpoint =
  !!process.env.PHOENIX_COLLECTOR_ENDPOINT || !!process.env.PHOENIX_BASE_URL;

if (!process.env.PHOENIX_API_KEY || !hasPhoenixEndpoint) {
  console.error(
    'Missing Phoenix configuration. Set PHOENIX_API_KEY plus PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_BASE_URL.',
  );
  process.exit(2);
}

let core;
try {
  core = await import('../packages/core/dist/index.js');
} catch (error) {
  console.error(
    'Could not load packages/core/dist/index.js. Run `npm run build -w @google/gemini-cli-core` first.',
  );
  console.error(error);
  process.exit(1);
}

const {
  GeminiCliOperation,
  initializeTelemetry,
  flushTelemetry,
  runInDevTraceSpan,
  shutdownTelemetry,
} = core;

const sessionId = `tracepilot-smoke-${Date.now()}`;
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
        source: 'scripts/phoenix-smoke.mjs',
      };
      metadata.output = {
        status: 'ok',
      };
      metadata.attributes['tracepilot.smoke_test'] = true;
      metadata.attributes['tracepilot.integration_path'] =
        'gemini_cli_telemetry_sdk';
      return 'ok';
    },
  );

  await flushTelemetry(config);
  await shutdownTelemetry(config, false);
  console.log(`Phoenix Gemini telemetry smoke succeeded for session ${sessionId}`);
} catch (error) {
  console.error('Phoenix Gemini telemetry smoke failed:', error);
  await shutdownTelemetry(config, false);
  process.exit(1);
}
