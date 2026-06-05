#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resolvePhoenixMcpPackage,
  resolveTracePilotPhoenixEnv,
} from '../packages/core/src/telemetry/phoenixMcpUtils.js';
import { redactSensitiveText } from '../packages/core/src/telemetry/sanitize.js';
import { resolveTracePilotNpmCommand } from './tracepilot-command-resolution.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

const REQUIRED_TRACEPILOT_SCRIPTS = [
  'ci:tracepilot',
  'tracepilot:check',
  'doctor:tracepilot',
  'eval:tracepilot',
  'judge:tracepilot',
  'dashboard:tracepilot',
  'demo:broken-node-app',
  'demo:gemini-repair-agent',
] as const;

interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  detail?: string;
}

interface DoctorReport {
  ok: boolean;
  localDeterministicReady: boolean;
  strictLiveReady: boolean;
  generatedAt: string;
  node: {
    version: string;
    executable: string;
  };
  npm: {
    available: boolean;
    version?: string;
    reason?: string;
  };
  packages: {
    nodeModulesPresent: boolean;
    tsxPresent: boolean;
    vitestPresent: boolean;
    typescriptPresent: boolean;
  };
  commandSurface: {
    requiredScriptsPresent: boolean;
    scripts: Record<(typeof REQUIRED_TRACEPILOT_SCRIPTS)[number], boolean>;
  };
  phoenix: {
    collectorReady: boolean;
    mcpReady: boolean;
    normalizedHostPresent: boolean;
    projectPresent: boolean;
    collectorSkipReason?: string;
    mcpSkipReason?: string;
    mcpPackage: string;
  };
  gemini: {
    apiKeyPresent: boolean;
  };
  recommendedCommands: string[];
  checks: DoctorCheck[];
}

interface CliOptions {
  output?: string;
  json: boolean;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const report = buildDoctorReport(process.env);
  if (options.output) {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanSummary(report);
  }
  return report.ok ? 0 : 1;
}

function buildDoctorReport(env: NodeJS.ProcessEnv): DoctorReport {
  const phoenixEnv = resolveTracePilotPhoenixEnv(env);
  const npm = checkNpm();
  const packages = {
    nodeModulesPresent: existsSync(path.resolve('node_modules')),
    tsxPresent: existsSync(path.resolve('node_modules', 'tsx')),
    vitestPresent: existsSync(path.resolve('node_modules', 'vitest')),
    typescriptPresent: existsSync(path.resolve('node_modules', 'typescript')),
  };
  const gemini = {
    apiKeyPresent: nonEmpty(env['GEMINI_API_KEY']) !== undefined,
  };
  const commandSurface = checkCommandSurface();
  const phoenix = {
    collectorReady: phoenixEnv.collectorReady,
    mcpReady: phoenixEnv.mcpReady,
    normalizedHostPresent: phoenixEnv.normalizedHost !== undefined,
    projectPresent: phoenixEnv.project !== undefined,
    collectorSkipReason: phoenixEnv.collectorSkipReason,
    mcpSkipReason: phoenixEnv.mcpSkipReason,
    mcpPackage: sanitize(resolvePhoenixMcpPackage(env)),
  };
  const localDeterministicReady =
    packages.nodeModulesPresent &&
    packages.tsxPresent &&
    packages.vitestPresent &&
    packages.typescriptPresent &&
    commandSurface.requiredScriptsPresent;
  const strictLiveReady =
    localDeterministicReady &&
    gemini.apiKeyPresent &&
    phoenix.collectorReady &&
    phoenix.mcpReady;
  const checks = buildChecks({
    npm,
    packages,
    commandSurface,
    phoenix,
    gemini,
  });

  return {
    ok: localDeterministicReady,
    localDeterministicReady,
    strictLiveReady,
    generatedAt: new Date().toISOString(),
    node: {
      version: process.version,
      executable: process.execPath,
    },
    npm,
    packages,
    commandSurface,
    phoenix,
    gemini,
    recommendedCommands: strictLiveReady
      ? [
          'npm run ci:tracepilot -- --tier=medium',
          'npm run tracepilot:check',
          'npm run smoke:phoenix:mcp',
          'npm run demo:gemini-repair-agent',
          'npm run judge:tracepilot -- --repair-artifact .ai-logs/tracepilot-check/repair-artifact.json --eval-report .ai-logs/demo-gemini-repair-agent/result.json --judge-input-output .ai-logs/tracepilot-judge/judge-input.json --judge-result-output .ai-logs/tracepilot-judge/judge-result.json',
          'npm run dashboard:tracepilot -- --report .ai-logs/demo-gemini-repair-agent/result.json --repair-artifact .ai-logs/tracepilot-check/repair-artifact.json --judge-input .ai-logs/tracepilot-judge/judge-input.json --judge-result .ai-logs/tracepilot-judge/judge-result.json --output .ai-logs/tracepilot-dashboard/index.html',
        ]
      : [
          'npm run ci:tracepilot',
          'npm run tracepilot:check',
          'npm run demo:broken-node-app:offline',
          'npm run demo:gemini-repair-agent:offline',
          'npm run dashboard:tracepilot -- --report .ai-logs/demo-broken-node-app/result.json --output .ai-logs/tracepilot-dashboard/index.html',
        ],
    checks,
  };
}

function buildChecks(input: {
  npm: DoctorReport['npm'];
  packages: DoctorReport['packages'];
  commandSurface: DoctorReport['commandSurface'];
  phoenix: DoctorReport['phoenix'];
  gemini: DoctorReport['gemini'];
}): DoctorCheck[] {
  return [
    {
      id: 'node',
      status: 'pass',
      summary: `Node ${process.version}`,
    },
    {
      id: 'npm',
      status: input.npm.available ? 'pass' : 'warn',
      summary: input.npm.available
        ? `npm ${input.npm.version}`
        : 'npm command is not available',
      detail: input.npm.reason,
    },
    {
      id: 'local-packages',
      status:
        input.packages.nodeModulesPresent &&
        input.packages.tsxPresent &&
        input.packages.vitestPresent &&
        input.packages.typescriptPresent
          ? 'pass'
          : 'fail',
      summary: 'Local TracePilot package tools',
      detail: `node_modules=${input.packages.nodeModulesPresent} tsx=${input.packages.tsxPresent} vitest=${input.packages.vitestPresent} typescript=${input.packages.typescriptPresent}`,
    },
    {
      id: 'tracepilot-command-surface',
      status: input.commandSurface.requiredScriptsPresent ? 'pass' : 'fail',
      summary: 'TracePilot npm scripts',
      detail: Object.entries(input.commandSurface.scripts)
        .map(([script, present]) => `${script}=${present}`)
        .join(' '),
    },
    {
      id: 'gemini-env',
      status: input.gemini.apiKeyPresent ? 'pass' : 'warn',
      summary: input.gemini.apiKeyPresent
        ? 'Gemini API key present'
        : 'Gemini API key missing',
    },
    {
      id: 'phoenix-collector-env',
      status: input.phoenix.collectorReady ? 'pass' : 'warn',
      summary: input.phoenix.collectorReady
        ? 'Phoenix collector env ready'
        : 'Phoenix collector env missing',
      detail: input.phoenix.collectorSkipReason,
    },
    {
      id: 'phoenix-mcp-env',
      status: input.phoenix.mcpReady ? 'pass' : 'warn',
      summary: input.phoenix.mcpReady
        ? 'Phoenix MCP env ready'
        : 'Phoenix MCP env missing',
      detail: input.phoenix.mcpSkipReason,
    },
  ];
}

function checkCommandSurface(): DoctorReport['commandSurface'] {
  const packageScripts = readPackageScripts();
  const scripts = Object.fromEntries(
    REQUIRED_TRACEPILOT_SCRIPTS.map((script) => [
      script,
      typeof packageScripts[script] === 'string',
    ]),
  ) as DoctorReport['commandSurface']['scripts'];
  return {
    requiredScriptsPresent: Object.values(scripts).every(Boolean),
    scripts,
  };
}

function readPackageScripts(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      readFileSync(path.resolve('package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, unknown>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function checkNpm(): DoctorReport['npm'] {
  try {
    const command = resolveTracePilotNpmCommand(['--version']);
    const version = execFileSync(command.executable, command.args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
    return {
      available: true,
      version: sanitize(version),
    };
  } catch (error) {
    return {
      available: false,
      reason: sanitize(getErrorMessage(error)),
    };
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--output') {
      options.output = argv[++index];
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

function printHumanSummary(report: DoctorReport): void {
  console.log(
    `TracePilot local deterministic readiness: ${report.localDeterministicReady ? 'ready' : 'not_ready'}`,
  );
  console.log(
    `TracePilot strict live readiness: ${report.strictLiveReady ? 'ready' : 'not_ready'}`,
  );
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
  }
  console.log(`Phoenix MCP package: ${report.phoenix.mcpPackage}`);
  for (const command of report.recommendedCommands) {
    console.log(`Recommended command: ${command}`);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitize(value: string): string {
  return redactSensitiveText(value).value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
