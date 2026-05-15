#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createTracePilotCloudRunServer } from './tracepilot-cloud-run-server.mjs';

let localServer;

const options = parseArgs(process.argv.slice(2));
const baseUrl = options.url ?? (await startLocalServer());

try {
  const health = await getJson(`${baseUrl}/api/health`);
  assert(health.ok === true, 'api health did not return ok=true');
  assert(
    health.service === 'tracepilot-cloud-run-demo',
    'api health returned the wrong service name',
  );

  const status = await getJson(`${baseUrl}/api/status`);
  assert(status.ok === true, 'status did not return ok=true');
  assert(
    typeof status.env?.GEMINI_API_KEY === 'boolean',
    'status must expose env presence as booleans only',
  );
  assertNoSecretText(status);

  const demo = await getJson(`${baseUrl}/api/demo`);
  assert(demo.ok === true, 'demo readiness did not return ok=true');
  assert(
    demo.demo?.localRepairAvailable === true,
    'demo readiness must advertise the deterministic repair path',
  );
  assertNoSecretText(demo);

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: baseUrl,
        cloudRunDetected: status.cloudRun?.detected === true,
        phoenixConfigured: status.phoenix?.configured === true,
        geminiConfigured: status.gemini?.configured === true,
      },
      null,
      2,
    ),
  );
} finally {
  if (localServer) {
    await new Promise((resolve) => localServer.close(resolve));
  }
}

async function startLocalServer() {
  localServer = createTracePilotCloudRunServer();
  localServer.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const address = localServer.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Could not resolve local server port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--url') {
      parsed.url = normalizeUrl(args[++index]);
    }
  }
  return parsed;
}

function normalizeUrl(value) {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('--url requires a non-empty URL');
  }
  return trimmed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoSecretText(value) {
  const text = JSON.stringify(value);
  const forbidden = [
    /AIza[0-9A-Za-z_-]{20,}/,
    /sk-[A-Za-z0-9_-]{16,}/,
    /ghp_[A-Za-z0-9_]{20,}/,
    /Bearer\s+[A-Za-z0-9._~+/=-]+/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      throw new Error(`response leaked secret-like text matching ${pattern}`);
    }
  }
}
