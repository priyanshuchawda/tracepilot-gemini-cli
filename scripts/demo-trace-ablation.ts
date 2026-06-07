#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';

const execFileAsync = promisify(execFile);
const PROMPT = [
  'A production settlement was charged twice after a delivery retry, but the public tests pass.',
  'Investigate and repair the root cause.',
  'If .tracepilot/production-trace.json exists, treat it as trusted runtime evidence.',
  'Preserve retry behavior and reject reuse of an idempotency key for a different payload.',
  'Keep production changes under src; diagnostic tests may be added.',
  'Run the public tests after applying the smallest production fix.',
  'Do not only explain the change.',
].join(' ');

interface Options {
  output: string;
  envFile: string;
  cliPath: string;
  model: string;
  agentScript?: string;
  timeoutMs: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  dotenv.config({ path: options.envFile, quiet: true });
  const fixture = path.resolve('examples/distributed-settlement-incident');
  const comparisonRoot = path.join(
    tmpdir(),
    `tracepilot-ablation-${Date.now()}`,
  );
  const fixtureDigest = await digestDirectory(fixture);
  const arms = [];
  for (const evidenceAccess of [false, true]) {
    const arm = evidenceAccess ? 'trace_assisted' : 'blind';
    const workspace = path.join(comparisonRoot, arm);
    await cp(fixture, workspace, { recursive: true });
    if (evidenceAccess) {
      await mkdir(path.join(workspace, '.tracepilot'), { recursive: true });
      await cp(
        path.resolve('scripts/testing/distributed-settlement-trace.json'),
        path.join(workspace, '.tracepilot', 'production-trace.json'),
      );
    }
    const workspaceDigestBefore = await digestDirectory(workspace, [
      '.tracepilot/production-trace.json',
    ]);
    const publicBefore = await runNode(workspace, ['--test']);
    const hiddenBefore = await runHiddenEvaluator(workspace);
    const agent = options.agentScript
      ? await runNode(
          workspace,
          [path.resolve(options.agentScript), workspace],
          options.timeoutMs,
        )
      : await runGemini(options, workspace, arm);
    const publicAfter = await runNode(workspace, ['--test']);
    const hiddenAfter = await runHiddenEvaluator(workspace);
    const changedFiles = await changedFilesAgainstFixture(fixture, workspace);
    const productionChangedFiles = changedFiles.filter((file) =>
      file.startsWith('src/'),
    );
    const changesWithinAllowedScope = changedFiles.every(
      (file) => file.startsWith('src/') || file.startsWith('test/'),
    );
    arms.push({
      arm,
      evidenceAccess,
      workspaceDigestBefore,
      publicTestsPassedBefore: publicBefore.exitCode === 0,
      hiddenBefore,
      agent: {
        exitCode: agent.exitCode,
        durationMs: agent.durationMs,
        output: summarizeOutput(agent),
      },
      publicTestsPassedAfter: publicAfter.exitCode === 0,
      hiddenAfter,
      changedFiles,
      productionChangedFiles,
      changesWithinAllowedScope,
      solved:
        agent.exitCode === 0 &&
        publicAfter.exitCode === 0 &&
        hiddenAfter.ok === true &&
        productionChangedFiles.length > 0 &&
        changesWithinAllowedScope,
    });
  }

  const report = {
    ok:
      arms.every((arm) => arm.workspaceDigestBefore === fixtureDigest) &&
      arms.some((arm) => arm.arm === 'trace_assisted' && arm.solved),
    benchmark: 'distributed-settlement-trace-ablation',
    generatedAt: new Date().toISOString(),
    model: options.agentScript ? 'controlled-substitute' : options.model,
    prompt: PROMPT,
    promptSha256: sha256(PROMPT),
    fixtureSha256: fixtureDigest,
    budgetMs: options.timeoutMs,
    samePrompt: true,
    sameStartingWorkspace: arms.every(
      (arm) => arm.workspaceDigestBefore === fixtureDigest,
    ),
    hiddenEvaluatorVisibleToAgent: false,
    competitorClaimsMeasured: false,
    arms,
    outcome: summarizeOutcome(arms),
  };
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`MODEL: ${report.model}`);
  console.log(`PROMPT_SHA256: ${report.promptSha256}`);
  console.log(`SAME_STARTING_WORKSPACE: ${report.sameStartingWorkspace}`);
  for (const arm of arms) {
    console.log(
      `ABLATION_ARM: ${arm.arm} evidence=${arm.evidenceAccess} hidden_score=${arm.hiddenAfter.score} solved=${arm.solved} duration_ms=${arm.agent.durationMs}`,
    );
  }
  console.log(`ABLATION_OUTCOME: ${report.outcome}`);
  console.log(`REPORT: ${output}`);
  await rm(comparisonRoot, { recursive: true, force: true });
  return report.ok ? 0 : 1;
}

async function runGemini(
  options: Options,
  workspace: string,
  arm: string,
): Promise<CommandResult> {
  const home = path.join(
    tmpdir(),
    'tracepilot-ablation-home',
    `${Date.now()}-${arm}`,
  );
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await writeFile(
    path.join(home, '.gemini', 'settings.json'),
    `${JSON.stringify({ tools: { shell: { enableInteractiveShell: false } } }, null, 2)}\n`,
    'utf8',
  );
  return runNode(
    workspace,
    [
      options.cliPath,
      '--prompt',
      PROMPT,
      '--approval-mode=yolo',
      '--sandbox=false',
      '--skip-trust',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
    ],
    options.timeoutMs,
    {
      GEMINI_CLI_HOME: home,
      GEMINI_CLI_NO_RELAUNCH: 'true',
    },
  );
}

async function runHiddenEvaluator(workspace: string) {
  const result = await runNode(workspace, [
    path.resolve('scripts/testing/distributed-settlement-hidden-evaluator.mjs'),
    workspace,
  ]);
  try {
    return JSON.parse(result.stdout) as {
      ok: boolean;
      score: number;
      passed: number;
      total: number;
      checks: unknown[];
    };
  } catch {
    return {
      ok: false,
      score: 0,
      passed: 0,
      total: 3,
      checks: [{ status: 'fail', reason: 'evaluator output invalid' }],
    };
  }
}

async function runNode(
  cwd: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function changedFilesAgainstFixture(
  fixture: string,
  workspace: string,
): Promise<string[]> {
  const fixtureFiles = await fileContents(fixture);
  const workspaceFiles = await fileContents(workspace, ['.tracepilot']);
  return [...new Set([...fixtureFiles.keys(), ...workspaceFiles.keys()])]
    .filter((file) => fixtureFiles.get(file) !== workspaceFiles.get(file))
    .sort();
}

async function digestDirectory(
  root: string,
  excludedFiles: string[] = [],
): Promise<string> {
  const files = await fileContents(root);
  const hash = createHash('sha256');
  for (const [file, content] of files) {
    if (!excludedFiles.includes(file)) {
      hash.update(file);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

async function fileContents(
  root: string,
  excludedDirectories: string[] = [],
  current = '',
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(path.join(root, current))) {
    const relative = path.join(current, entry);
    const normalized = relative.replaceAll('\\', '/');
    const entryStat = await stat(path.join(root, relative));
    if (entryStat.isDirectory()) {
      if (!excludedDirectories.includes(normalized)) {
        for (const [file, content] of await fileContents(
          root,
          excludedDirectories,
          relative,
        )) {
          result.set(file, content);
        }
      }
    } else {
      result.set(normalized, await readFile(path.join(root, relative), 'utf8'));
    }
  }
  return result;
}

function summarizeOutput(result: CommandResult) {
  const preview = createRedactedOutputPreview(
    `${result.stdout}\n${result.stderr}`,
  );
  return { preview: preview.preview, sha256: preview.sha256 };
}

function summarizeOutcome(
  arms: Array<{ arm: string; solved: boolean; hiddenAfter: { score: number } }>,
): string {
  const blind = arms.find((arm) => arm.arm === 'blind');
  const assisted = arms.find((arm) => arm.arm === 'trace_assisted');
  if (!blind || !assisted) return 'incomplete';
  if (!blind.solved && assisted.solved) return 'trace_assistance_advantage';
  if (blind.solved && assisted.solved) return 'both_solved';
  if (!blind.solved && !assisted.solved) return 'neither_solved';
  return 'blind_only';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    output: '.ai-logs/trace-ablation/result.json',
    envFile: path.resolve('.env'),
    cliPath: path.resolve('packages/cli/dist/index.js'),
    model: 'gemini-3.1-flash-lite-preview',
    timeoutMs: 10 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1];
    if (argv[index] === '--output' && value) options.output = value;
    if (argv[index] === '--env-file' && value)
      options.envFile = path.resolve(value);
    if (argv[index] === '--cli-path' && value)
      options.cliPath = path.resolve(value);
    if (argv[index] === '--model' && value) options.model = value;
    if (argv[index] === '--agent-script' && value) options.agentScript = value;
    if (argv[index] === '--timeout-ms' && value)
      options.timeoutMs = Number.parseInt(value, 10);
  }
  return options;
}

process.exitCode = await main(process.argv.slice(2));
