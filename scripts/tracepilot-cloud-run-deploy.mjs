#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);
const GCLOUD = 'gcloud';
const IS_WINDOWS = process.platform === 'win32';

const options = parseArgs(process.argv.slice(2));
const project = options.project ?? (await getGcloudProject());
if (!project) {
  fail(
    'No Google Cloud project configured. Run `gcloud config set project <project-id>` or pass --project.',
  );
}

const image = `${options.region}-docker.pkg.dev/${project}/${options.repository}/${options.service}:${options.tag}`;
const commonRunArgs = [
  '--project',
  project,
  '--region',
  options.region,
  '--quiet',
];
const deployArgs = buildDeployArgs(options, image, commonRunArgs);

if (options.dryRun) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        project,
        region: options.region,
        service: options.service,
        image,
        demoRunsEnabled: options.enableDemoRuns === 'true',
        secretsConfigured: Object.keys(options.secrets),
        envConfigured: Object.keys(options.envVars),
        deployArgs: redactArgs(deployArgs),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

await run(GCLOUD, [
  'services',
  'enable',
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  '--project',
  project,
]);

const repoExists = await commandSucceeds(GCLOUD, [
  'artifacts',
  'repositories',
  'describe',
  options.repository,
  '--location',
  options.region,
  '--project',
  project,
]);
if (!repoExists) {
  await run(GCLOUD, [
    'artifacts',
    'repositories',
    'create',
    options.repository,
    '--repository-format',
    'docker',
    '--location',
    options.region,
    '--description',
    'TracePilot-Cloud-Run-demo-images',
    '--project',
    project,
  ]);
}

await run(GCLOUD, [
  'builds',
  'submit',
  '--config',
  'cloudbuild.tracepilot-cloud-run.yaml',
  '--substitutions',
  `_IMAGE=${image}`,
  '--project',
  project,
  '.',
]);

await run(GCLOUD, deployArgs);

const serviceUrl = (
  await execGcloud([
    'run',
    'services',
    'describe',
    options.service,
    '--format',
    'value(status.url)',
    ...commonRunArgs,
  ])
).stdout.trim();

console.log(
  JSON.stringify(
    {
      ok: true,
      project,
      region: options.region,
      service: options.service,
      image,
      url: serviceUrl,
      demoRunsEnabled: options.enableDemoRuns === 'true',
      secretsConfigured: Object.keys(options.secrets),
      envConfigured: Object.keys(options.envVars),
    },
    null,
    2,
  ),
);

function parseArgs(args) {
  const parsed = {
    region: process.env.GOOGLE_CLOUD_REGION || 'us-central1',
    repository: 'tracepilot',
    service: 'tracepilot-demo',
    tag: process.env.GITHUB_SHA || `manual-${Date.now()}`,
    phoenixProject: process.env.PHOENIX_PROJECT || 'tracepilot-gemini-cli',
    enableDemoRuns: 'false',
    dryRun: false,
    envVars: {
      PHOENIX_PROJECT: process.env.PHOENIX_PROJECT || 'tracepilot-gemini-cli',
      TRACEPILOT_ENABLE_DEMO_RUNS: 'false',
    },
    secrets: {},
  };
  for (const [name, value] of [
    ['PHOENIX_HOST', process.env.PHOENIX_HOST],
    ['PHOENIX_BASE_URL', process.env.PHOENIX_BASE_URL],
    ['PHOENIX_COLLECTOR_ENDPOINT', process.env.PHOENIX_COLLECTOR_ENDPOINT],
  ]) {
    if (value) {
      parsed.envVars[name] = value;
    }
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--project') {
      parsed.project = args[++index];
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--region') {
      parsed.region = args[++index] ?? parsed.region;
    } else if (arg === '--repository') {
      parsed.repository = args[++index] ?? parsed.repository;
    } else if (arg === '--service') {
      parsed.service = args[++index] ?? parsed.service;
    } else if (arg === '--tag') {
      parsed.tag = args[++index] ?? parsed.tag;
    } else if (arg === '--phoenix-project') {
      parsed.phoenixProject = args[++index] ?? parsed.phoenixProject;
      parsed.envVars.PHOENIX_PROJECT = parsed.phoenixProject;
    } else if (arg === '--phoenix-host') {
      parsed.envVars.PHOENIX_HOST = args[++index] ?? '';
    } else if (arg === '--phoenix-base-url') {
      parsed.envVars.PHOENIX_BASE_URL = args[++index] ?? '';
    } else if (arg === '--phoenix-collector-endpoint') {
      parsed.envVars.PHOENIX_COLLECTOR_ENDPOINT = args[++index] ?? '';
    } else if (arg === '--set-env') {
      const [envName, ...valueParts] = String(args[++index] ?? '').split('=');
      const value = valueParts.join('=');
      if (!envName || !value) {
        fail('--set-env must use ENV_NAME=value');
      }
      parsed.envVars[envName] = value;
    } else if (arg === '--enable-demo-runs') {
      parsed.enableDemoRuns = 'true';
      parsed.envVars.TRACEPILOT_ENABLE_DEMO_RUNS = 'true';
    } else if (arg === '--secret') {
      const [envName, secretName] = String(args[++index] ?? '').split('=');
      if (!envName || !secretName) {
        fail('--secret must use ENV_NAME=secret-manager-name');
      }
      parsed.secrets[envName] = secretName;
    }
  }

  return parsed;
}

function buildDeployArgs(options, image, commonRunArgs) {
  const deployArgs = [
    'run',
    'deploy',
    options.service,
    '--image',
    image,
    '--allow-unauthenticated',
    '--min-instances',
    '0',
    '--max-instances',
    '1',
    '--cpu',
    '1',
    '--memory',
    '1Gi',
    '--timeout',
    '300',
    '--port',
    '8080',
    '--set-env-vars',
    serializeEnvVars(options.envVars),
    ...commonRunArgs,
  ];
  for (const [envName, secretName] of Object.entries(options.secrets)) {
    deployArgs.push('--set-secrets', `${envName}=${secretName}:latest`);
  }
  return deployArgs;
}

function serializeEnvVars(envVars) {
  return Object.entries(envVars)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
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

async function commandSucceeds(command, args) {
  try {
    await execCommand(command, args, 1024 * 1024);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args) {
  console.error(`RUN ${command} ${redactArgs(args).join(' ')}`);
  try {
    const result = await execCommand(command, args, 1024 * 1024 * 10);
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

async function execGcloud(args) {
  return execCommand(GCLOUD, args, 1024 * 1024);
}

async function execCommand(command, args, maxBuffer) {
  if (!IS_WINDOWS) {
    return execFileAsync(command, args, { maxBuffer });
  }
  return execFileAsync(
    'cmd.exe',
    ['/d', '/s', '/c', quoteWindowsCommand(command, args)],
    { maxBuffer },
  );
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
  return args.map((arg, index) => {
    const text = String(arg);
    if (String(args[index - 1]) === '--set-env-vars') {
      return redactEnvVarList(text);
    }
    return redactSecretLikeText(text);
  });
}

function redactEnvVarList(value) {
  return String(value)
    .split(',')
    .map((entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        return redactSecretLikeText(entry);
      }
      return `${entry.slice(0, separatorIndex)}=[VALUE]`;
    })
    .join(',');
}

function redactText(text) {
  return redactSecretLikeText(String(text)).replace(
    /\b([A-Z][A-Z0-9_]{2,})(=)([^,\s]+)/g,
    '$1$2[VALUE]',
  );
}

function redactSecretLikeText(text) {
  return String(text)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
