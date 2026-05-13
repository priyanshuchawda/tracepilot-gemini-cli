#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE_NAME = 'tracepilot-cloud-run-demo';
const SECRET_NAMES = [
  'GEMINI_API_KEY',
  'PHOENIX_API_KEY',
  'PHOENIX_CLIENT_HEADERS',
  'GOOGLE_APPLICATION_CREDENTIALS',
];
const ENV_STATUS_NAMES = [
  'GEMINI_API_KEY',
  'PHOENIX_API_KEY',
  'PHOENIX_HOST',
  'PHOENIX_BASE_URL',
  'PHOENIX_COLLECTOR_ENDPOINT',
  'PHOENIX_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'K_SERVICE',
  'K_REVISION',
  'K_CONFIGURATION',
  'TRACEPILOT_ENABLE_DEMO_RUNS',
];

export function createTracePilotCloudRunServer(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const runDemo = options.runDemo ?? runDeterministicDemo;

  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (
        request.method === 'GET' &&
        (url.pathname === '/healthz' || url.pathname === '/api/health')
      ) {
        sendJson(response, 200, {
          ok: true,
          service: SERVICE_NAME,
          timestamp: now().toISOString(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, buildStatus(env, now));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/demo') {
        sendJson(response, 200, buildDemoReadiness(env));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/demo/run') {
        if (env.TRACEPILOT_ENABLE_DEMO_RUNS !== 'true') {
          sendJson(response, 403, {
            ok: false,
            error:
              'Demo runs are disabled. Set TRACEPILOT_ENABLE_DEMO_RUNS=true for controlled demo environments.',
          });
          return;
        }
        const strictPhoenix = url.searchParams.get('strictPhoenix') === 'true';
        const result = await runDemo({ strictPhoenix, env });
        sendJson(response, result.ok ? 200 : 500, result);
        return;
      }

      sendJson(response, 404, {
        ok: false,
        error: 'not_found',
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: redactMessage(getErrorMessage(error), env),
      });
    }
  });
}

export function buildStatus(env = process.env, now = () => new Date()) {
  return {
    ok: true,
    service: SERVICE_NAME,
    timestamp: now().toISOString(),
    env: Object.fromEntries(
      ENV_STATUS_NAMES.map((name) => [name, hasEnv(env, name)]),
    ),
    phoenix: {
      configured:
        hasEnv(env, 'PHOENIX_API_KEY') &&
        hasEnv(env, 'PHOENIX_PROJECT') &&
        (hasEnv(env, 'PHOENIX_HOST') ||
          hasEnv(env, 'PHOENIX_BASE_URL') ||
          hasEnv(env, 'PHOENIX_COLLECTOR_ENDPOINT')),
      mcpHostConfigured:
        hasEnv(env, 'PHOENIX_HOST') ||
        hasEnv(env, 'PHOENIX_BASE_URL') ||
        hasEnv(env, 'PHOENIX_COLLECTOR_ENDPOINT'),
    },
    gemini: {
      configured: hasEnv(env, 'GEMINI_API_KEY'),
    },
    cloudRun: {
      detected: hasEnv(env, 'K_SERVICE'),
      service: safeOptional(env.K_SERVICE),
      revision: safeOptional(env.K_REVISION),
    },
  };
}

export function buildDemoReadiness(env = process.env) {
  const status = buildStatus(env);
  return {
    ok: true,
    service: SERVICE_NAME,
    demo: {
      localRepairAvailable: true,
      strictPhoenixAvailable: status.phoenix.configured,
      liveGeminiConfigured: status.gemini.configured,
      demoRunsEnabled: env.TRACEPILOT_ENABLE_DEMO_RUNS === 'true',
      fixedEndpoints: [
        'GET /healthz',
        'GET /api/health',
        'GET /api/status',
        'GET /api/demo',
        'POST /api/demo/run',
      ],
    },
    status,
  };
}

async function runDeterministicDemo({ strictPhoenix, env }) {
  const outputDir = path.join(tmpdir(), 'tracepilot-cloud-run-demo');
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `result-${Date.now()}.json`);
  const args = [
    '--import',
    'tsx',
    'scripts/demo-broken-node-app.ts',
    '--output',
    output,
  ];
  if (!strictPhoenix) {
    args.push('--allow-missing-phoenix');
  }

  try {
    await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      error: redactMessage(getErrorMessage(error), env),
      output,
    };
  }

  const report = JSON.parse(await readFile(output, 'utf8'));
  return {
    ok: report.ok === true,
    output,
    summary: {
      localRepairOk: report.localRepairOk === true,
      phoenixVisible: report.phoenix?.visible === true,
      phoenixQueryable: report.phoenix?.queryable === true,
      evalOk: report.eval?.ok === true,
      sessionId: report.sessionId,
    },
  };
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function hasEnv(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

function safeOptional(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function redactMessage(message, env = process.env) {
  let text = String(message);
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 8) {
      text = text.split(value).join('[REDACTED]');
    }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
    .replace(
      /(api[_-]?key|password|authorization)(["']?\s*[:=]\s*)["']?[^"',\s]+/gi,
      '$1$2[REDACTED]',
    );
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const server = createTracePilotCloudRunServer();
  server.listen(port, () => {
    const address = server.address();
    const resolvedPort =
      typeof address === 'object' && address ? address.port : port;
    console.log(`${SERVICE_NAME} listening on port ${resolvedPort}`);
  });
}
