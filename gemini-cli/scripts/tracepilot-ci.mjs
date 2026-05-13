#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const logDir = path.resolve('.ai-logs', 'tracepilot-ci');
const summaryPath = path.join(logDir, 'summary.json');
const secretValues = [
  process.env.GEMINI_API_KEY,
  process.env.PHOENIX_API_KEY,
  process.env.PHOENIX_HOST,
  process.env.PHOENIX_BASE_URL,
  process.env.PHOENIX_COLLECTOR_ENDPOINT,
].filter((value) => typeof value === 'string' && value.length >= 8);

const requiredCommands = [
  command('lint', 'npm', ['run', 'lint']),
  command('typecheck', 'npm', ['run', 'typecheck']),
  command('build', 'npm', ['run', 'build']),
  command('tracepilot-tests', 'npm', ['run', 'test:tracepilot']),
  command('broken-node-demo-offline', 'npm', [
    'run',
    'demo:broken-node-app:offline',
  ]),
];

const optionalCommands = [
  {
    ...command('phoenix-otel-smoke', 'npm', ['run', 'smoke:phoenix']),
    shouldRun: hasPhoenixCollectorEnv,
    skipReason:
      'missing PHOENIX_API_KEY plus PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_BASE_URL',
  },
  {
    ...command('phoenix-mcp-smoke', 'npm', ['run', 'smoke:phoenix:mcp']),
    shouldRun: hasPhoenixMcpEnv,
    skipReason:
      'missing PHOENIX_API_KEY, PHOENIX_PROJECT, or a real Phoenix host/base/collector URL',
  },
];

await mkdir(logDir, { recursive: true });

const results = [];
for (const item of requiredCommands) {
  results.push(await runCommand(item));
}
for (const item of optionalCommands) {
  if (item.shouldRun()) {
    results.push(await runCommand(item));
  } else {
    const result = {
      name: item.name,
      status: 'skipped',
      reason: item.skipReason,
      log: undefined,
    };
    results.push(result);
    console.log(`SKIP ${item.name}: ${item.skipReason}`);
  }
}

const summary = {
  ok: results.every(
    (result) => result.status === 'passed' || result.status === 'skipped',
  ),
  generatedAt: new Date().toISOString(),
  results,
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`TracePilot CI summary: ${summaryPath}`);

if (!summary.ok) {
  process.exitCode = 1;
}

function command(name, executable, args) {
  return { name, executable, args };
}

async function runCommand(item) {
  const logPath = path.join(logDir, `${item.name}.log`);
  console.log(`RUN ${item.name}`);
  const result = await spawnAndCapture(item.executable, item.args);
  await writeFile(logPath, redact(result.output), 'utf8');
  if (result.exitCode === 0) {
    console.log(`PASS ${item.name}`);
    return {
      name: item.name,
      status: 'passed',
      exitCode: result.exitCode,
      log: logPath,
    };
  }

  console.error(`FAIL ${item.name} exit ${result.exitCode}`);
  console.error(tailLines(redact(result.output), 120));
  return {
    name: item.name,
    status: 'failed',
    exitCode: result.exitCode,
    log: logPath,
  };
}

function spawnAndCapture(executable, args) {
  return new Promise((resolve) => {
    const command = resolveCommand(executable, args);
    const child = spawn(command.executable, command.args, {
      shell: false,
      env: {
        ...process.env,
        NO_COLOR: 'true',
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(redact(text));
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(redact(text));
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

function resolveCommand(executable, args) {
  if (executable === 'npm' && process.env.npm_execpath) {
    return {
      executable: process.execPath,
      args: [process.env.npm_execpath, ...args],
    };
  }
  return { executable, args };
}

function hasPhoenixCollectorEnv() {
  return Boolean(
    process.env.PHOENIX_API_KEY &&
      (process.env.PHOENIX_COLLECTOR_ENDPOINT || process.env.PHOENIX_BASE_URL),
  );
}

function hasPhoenixMcpEnv() {
  return Boolean(
    hasPhoenixCollectorEnv() &&
      process.env.PHOENIX_PROJECT &&
      resolvePhoenixBaseUrl(process.env),
  );
}

function resolvePhoenixBaseUrl(env) {
  for (const value of [
    env.PHOENIX_HOST,
    env.PHOENIX_BASE_URL,
    env.PHOENIX_COLLECTOR_ENDPOINT,
  ]) {
    const resolved = normalizePhoenixUrl(value);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function normalizePhoenixUrl(value) {
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

function redact(value) {
  let text = String(value ?? '');
  for (const secret of secretValues) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]');
}

function tailLines(value, count) {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}
