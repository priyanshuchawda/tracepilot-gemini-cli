#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);
const GCLOUD = 'gcloud';
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_SECRET_MAPPINGS = {
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  PHOENIX_API_KEY: 'PHOENIX_API_KEY',
};

const options = parseArgs(process.argv.slice(2));
const project = options.project ?? (await getGcloudProject());
if (!project) {
  fail(
    'No Google Cloud project configured. Run `gcloud config set project <project-id>` or pass --project.',
  );
}

const plan = buildSecretPlan(options.mappings, process.env);
if (plan.missing.length > 0) {
  fail(`Missing required env values: ${plan.missing.join(', ')}`);
}

if (!options.dryRun) {
  await runGcloud([
    'services',
    'enable',
    'secretmanager.googleapis.com',
    '--project',
    project,
  ]);
  for (const item of plan.items) {
    const exists = await commandSucceeds([
      'secrets',
      'describe',
      item.secretName,
      '--project',
      project,
    ]);
    if (!exists) {
      await runGcloud([
        'secrets',
        'create',
        item.secretName,
        '--replication-policy',
        'automatic',
        '--project',
        project,
      ]);
    }
    await addSecretVersion(project, item.secretName, item.value);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: options.dryRun,
      project,
      secrets: plan.items.map((item) => ({
        envName: item.envName,
        secretName: item.secretName,
        present: true,
        action: options.dryRun ? 'would-sync' : 'synced',
      })),
    },
    null,
    2,
  ),
);

export function parseArgs(args) {
  const parsed = {
    dryRun: false,
    mappings: { ...DEFAULT_SECRET_MAPPINGS },
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--project') {
      parsed.project = args[++index];
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--secret') {
      const [envName, secretName] = String(args[++index] ?? '').split('=');
      if (!envName || !secretName) {
        fail('--secret must use ENV_NAME=secret-manager-name');
      }
      parsed.mappings[envName] = secretName;
    }
  }
  return parsed;
}

export function buildSecretPlan(mappings, env) {
  const items = [];
  const missing = [];
  for (const [envName, secretName] of Object.entries(mappings)) {
    const value = env[envName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push(envName);
      continue;
    }
    items.push({ envName, secretName, value });
  }
  return { items, missing };
}

async function getGcloudProject() {
  try {
    const result = await execGcloud([
      'config',
      'get-value',
      'project',
      '--quiet',
    ]);
    const value = result.stdout.trim();
    return value && value !== '(unset)' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function commandSucceeds(args) {
  try {
    await execGcloud(args);
    return true;
  } catch {
    return false;
  }
}

async function runGcloud(args) {
  console.error(`RUN ${GCLOUD} ${redactArgs(args).join(' ')}`);
  try {
    const result = await execGcloud(args, 1024 * 1024 * 2);
    if (result.stdout.trim()) {
      console.error(result.stdout.trim());
    }
    if (result.stderr.trim()) {
      console.error(redactText(result.stderr.trim()));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(redactText(message));
  }
}

async function addSecretVersion(project, secretName, value) {
  console.error(
    `RUN ${GCLOUD} secrets versions add ${secretName} --data-file=-`,
  );
  const args = [
    'secrets',
    'versions',
    'add',
    secretName,
    '--data-file=-',
    '--project',
    project,
  ];
  const result = await spawnCommand(GCLOUD, args, value);
  if (result.code !== 0) {
    fail(redactText(result.stderr || result.stdout));
  }
}

async function execGcloud(args, maxBuffer = 1024 * 1024) {
  if (!IS_WINDOWS) {
    return execFileAsync(GCLOUD, args, { maxBuffer });
  }
  return execFileAsync(
    'cmd.exe',
    ['/d', '/s', '/c', quoteWindowsCommand(GCLOUD, args)],
    { maxBuffer },
  );
}

function spawnCommand(command, args, stdin) {
  return new Promise((resolve) => {
    const child = IS_WINDOWS
      ? spawn('cmd.exe', ['/d', '/s', '/c', quoteWindowsCommand(command, args)])
      : spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function quoteWindowsCommand(command, args) {
  return [command, ...args].map(quoteWindowsArg).join(' ');
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[ \t"&|<>^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["^])/g, '^$1')}"`;
}

function redactArgs(args) {
  return args.map((arg) =>
    String(arg).replace(/=AIza[0-9A-Za-z_-]{20,}/g, '=[REDACTED]'),
  );
}

function redactText(text) {
  return String(text)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      '[REDACTED_JWT]',
    );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
