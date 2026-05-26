#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
dotenv.config();
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveTracePilotPhoenixEnv,
  type TracePilotPhoenixEnv,
} from '../packages/core/src/telemetry/phoenixEnv.js';
import {
  describeTracePilotProofLevel,
  isStrictTracePilotProofLevel,
  TRACEPILOT_PROOF_LEVELS,
  type TracePilotProofLevel,
} from '../packages/core/src/tracepilot/proofLevel.js';
import { stableTracePilotProofReportJson } from '../packages/core/src/tracepilot/proofReport.js';

type GateTier = 'fast' | 'medium' | 'full';
type GateStatus = 'passed' | 'failed' | 'skipped';

interface CommandItem {
  name: string;
  executable: string;
  args: string[];
  tier: GateTier;
  expectedRuntime: string;
  optional: boolean;
}

interface OptionalCommandItem extends CommandItem {
  shouldRun: () => boolean;
  skipReason: string;
}

interface GateResult {
  name: string;
  status: GateStatus;
  exitCode?: number;
  log?: string;
  tier: GateTier;
  required: boolean;
  optional: boolean;
  expectedRuntime: string;
  reason?: string;
}

interface SpawnResult {
  exitCode: number;
  output: string;
}

const logDir = path.resolve('.ai-logs', 'tracepilot-ci');
const summaryPath = path.join(logDir, 'summary.json');
const verbose = process.env['TRACEPILOT_CI_VERBOSE'] === 'true';
const tier = resolveTier(process.argv.slice(2), process.env);
const phoenixEnv = resolveTracePilotPhoenixEnv(process.env);
const secretValues = [
  process.env['GEMINI_API_KEY'],
  process.env['PHOENIX_API_KEY'],
  process.env['PHOENIX_HOST'],
  process.env['PHOENIX_BASE_URL'],
  process.env['PHOENIX_COLLECTOR_ENDPOINT'],
].filter(
  (value): value is string => typeof value === 'string' && value.length >= 8,
);

const commandCatalog: CommandItem[] = [
  command('tracepilot-tests', 'npm', ['run', 'test:tracepilot'], {
    tier: 'fast',
    expectedRuntime: '2-5m',
  }),
  command('lint', 'npm', ['run', 'lint'], {
    tier: 'medium',
    expectedRuntime: '3-8m',
  }),
  command('typecheck', 'npm', ['run', 'typecheck'], {
    tier: 'medium',
    expectedRuntime: '3-8m',
  }),
  command('build', 'npm', ['run', 'build'], {
    tier: 'medium',
    expectedRuntime: '2-6m',
  }),
  command(
    'broken-node-demo-offline',
    'npm',
    ['run', 'demo:broken-node-app:offline'],
    {
      tier: 'medium',
      expectedRuntime: '1-3m',
    },
  ),
  command('root-tests', 'npm', ['test'], {
    tier: 'full',
    expectedRuntime: '20-40m',
  }),
  command('cloud-run-local-smoke', 'npm', ['run', 'smoke:cloud-run:local'], {
    tier: 'full',
    expectedRuntime: '1-3m',
  }),
];

const optionalCommands: OptionalCommandItem[] = [
  {
    ...command('phoenix-otel-smoke', 'npm', ['run', 'smoke:phoenix'], {
      tier: 'medium',
      expectedRuntime: '1-3m',
      optional: true,
    }),
    shouldRun: () => phoenixEnv.collectorReady,
    skipReason:
      phoenixEnv.collectorSkipReason ??
      'Phoenix collector environment is unavailable',
  },
  {
    ...command('phoenix-mcp-smoke', 'npm', ['run', 'smoke:phoenix:mcp'], {
      tier: 'medium',
      expectedRuntime: '1-5m',
      optional: true,
    }),
    shouldRun: () => phoenixEnv.mcpReady,
    skipReason:
      phoenixEnv.mcpSkipReason ?? 'Phoenix MCP environment is unavailable',
  },
];

await mkdir(logDir, { recursive: true });

const results: GateResult[] = [];
const selectedRequiredCommands = commandCatalog.filter((item) =>
  shouldIncludeTier(item.tier, tier),
);
const tierSkippedCommands = commandCatalog
  .filter((item) => !shouldIncludeTier(item.tier, tier))
  .map((item) => skippedResult(item, `requires ${item.tier} tier`));

console.log(`TracePilot CI tier: ${tier} (${describeTier(tier)})`);

for (const item of selectedRequiredCommands) {
  results.push(await runCommand(item));
}
for (const result of tierSkippedCommands) {
  console.log(`SKIP ${result.name}: ${result.reason}`);
}
for (const item of optionalCommands) {
  if (!shouldIncludeTier(item.tier, tier)) {
    const result = skippedResult(item, `requires ${item.tier} tier`);
    results.push(result);
    console.log(`SKIP ${item.name}: ${result.reason}`);
  } else if (item.shouldRun()) {
    results.push(await runCommand(item));
  } else {
    const result = skippedResult(item, item.skipReason);
    results.push(result);
    console.log(`SKIP ${item.name}: ${item.skipReason}`);
  }
}
results.push(...tierSkippedCommands);

const proofLevel = deriveProofLevel(results);
const summary = {
  ok: results.every(
    (result) => result.status === 'passed' || result.status === 'skipped',
  ),
  tier,
  tierDescription: describeTier(tier),
  proofLevel,
  proofSummary: describeTracePilotProofLevel(proofLevel),
  strictLiveProof: isStrictTracePilotProofLevel(proofLevel),
  generatedAt: new Date().toISOString(),
  phoenixEnv: summarizePhoenixEnv(phoenixEnv),
  gates: partitionResults(results),
  results,
};
await writeFile(summaryPath, stableTracePilotProofReportJson(summary), 'utf8');
console.log(
  `PROOF_LEVEL: ${summary.proofLevel} strictLiveProof=${summary.strictLiveProof}`,
);
console.log(`TracePilot CI summary: ${summaryPath}`);

if (!summary.ok) {
  process.exitCode = 1;
}

function command(
  name: string,
  executable: string,
  args: string[],
  options: {
    tier: GateTier;
    expectedRuntime: string;
    optional?: boolean;
  },
): CommandItem {
  return {
    name,
    executable,
    args,
    tier: options.tier,
    expectedRuntime: options.expectedRuntime,
    optional: options.optional === true,
  };
}

function resolveTier(argv: string[], env: NodeJS.ProcessEnv): GateTier {
  const cliTier = getArgValue(argv, '--tier');
  const requested = (cliTier || env['TRACEPILOT_CI_TIER'] || 'fast')
    .trim()
    .toLowerCase();
  if (!isGateTier(requested)) {
    console.error(
      `Invalid TracePilot CI tier "${requested}". Use fast, medium, or full.`,
    );
    process.exit(1);
  }
  return requested;
}

function isGateTier(value: string): value is GateTier {
  return value === 'fast' || value === 'medium' || value === 'full';
}

function getArgValue(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === name) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function shouldIncludeTier(commandTier: GateTier, selectedTier: GateTier) {
  return tierRank(commandTier) <= tierRank(selectedTier);
}

function tierRank(value: GateTier): number {
  switch (value) {
    case 'fast':
      return 1;
    case 'medium':
      return 2;
    case 'full':
      return 3;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function describeTier(value: GateTier): string {
  switch (value) {
    case 'fast':
      return 'focused TracePilot regression checks for local iteration';
    case 'medium':
      return 'static checks, build, focused tests, offline demo, and env-gated Phoenix smokes';
    case 'full':
      return 'medium gates plus long root tests and local hosted-surface smoke';
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function deriveProofLevel(results: GateResult[]): TracePilotProofLevel {
  const phoenixMcp = results.find(
    (result) => result.name === 'phoenix-mcp-smoke',
  );
  return phoenixMcp?.status === 'passed'
    ? TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX
    : TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE;
}

async function runCommand(item: CommandItem): Promise<GateResult> {
  const logPath = path.join(logDir, `${item.name}.log`);
  console.log(
    `RUN ${item.name} [${item.tier}, expected ${item.expectedRuntime}]`,
  );
  const result = await spawnAndCapture(item.executable, item.args);
  await writeFile(logPath, redact(result.output), 'utf8');
  if (result.exitCode === 0) {
    console.log(`PASS ${item.name}`);
    return {
      name: item.name,
      status: 'passed',
      exitCode: result.exitCode,
      log: logPath,
      tier: item.tier,
      required: !item.optional,
      optional: item.optional,
      expectedRuntime: item.expectedRuntime,
    };
  }

  console.error(`FAIL ${item.name} exit ${result.exitCode}`);
  console.error(tailLines(redact(result.output), 120));
  return {
    name: item.name,
    status: 'failed',
    exitCode: result.exitCode,
    log: logPath,
    tier: item.tier,
    required: !item.optional,
    optional: item.optional,
    expectedRuntime: item.expectedRuntime,
  };
}

function skippedResult(item: CommandItem, reason: string): GateResult {
  return {
    name: item.name,
    status: 'skipped',
    reason,
    log: undefined,
    tier: item.tier,
    required: !item.optional,
    optional: item.optional,
    expectedRuntime: item.expectedRuntime,
  };
}

function partitionResults(results: GateResult[]) {
  return {
    required: results.filter(
      (result) => result.required && result.status !== 'skipped',
    ),
    optional: results.filter(
      (result) => result.optional && result.status !== 'skipped',
    ),
    skipped: results.filter((result) => result.status === 'skipped'),
  };
}

function summarizePhoenixEnv(env: TracePilotPhoenixEnv) {
  return {
    collectorReady: env.collectorReady,
    mcpReady: env.mcpReady,
    normalizedHostPresent: Boolean(env.normalizedHost),
    projectPresent: Boolean(env.project),
    collectorEndpointPresent: Boolean(env.collectorEndpoint),
    baseUrlPresent: Boolean(env.baseUrl),
    hostPresent: Boolean(env.host),
    collectorSkipReason: env.collectorSkipReason,
    mcpSkipReason: env.mcpSkipReason,
  };
}

function spawnAndCapture(
  executable: string,
  args: string[],
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const commandInfo = resolveCommand(executable, args);
    const child = spawn(commandInfo.executable, commandInfo.args, {
      shell: false,
      env: {
        ...process.env,
        NO_COLOR: 'true',
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (verbose) {
        process.stdout.write(redact(text));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (verbose) {
        process.stderr.write(redact(text));
      }
    });
    child.on('error', (error: Error) => {
      resolve({ exitCode: 1, output: `${output}${error.message}\n` });
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

function resolveCommand(
  executable: string,
  args: string[],
): { executable: string; args: string[] } {
  const npmExecPath =
    process.env['TRACEPILOT_CI_NPM_EXEC_PATH'] || process.env['npm_execpath'];
  if (executable === 'npm' && npmExecPath) {
    return {
      executable: process.execPath,
      args: [npmExecPath, ...args],
    };
  }
  return { executable, args };
}

function redact(value: unknown): string {
  let text = String(value ?? '');
  for (const secret of secretValues) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]');
}

function tailLines(value: string, count: number): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}
