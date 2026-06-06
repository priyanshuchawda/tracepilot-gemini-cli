#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';

const execFileAsync = promisify(execFile);

interface Options {
  workdir: string;
  output: string;
  envFile: string;
  cliPath: string;
  model: string;
  task?: string;
  agentScript?: string;
  stressRuns: number;
}

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  dotenv.config({ path: options.envFile, quiet: true });
  const fixture = path.resolve('examples/broken-idempotency-service');
  const workspace = path.resolve(options.workdir);
  const output = path.resolve(options.output);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.dirname(workspace), { recursive: true });
  await cp(fixture, workspace, { recursive: true });

  const sourcePath = path.join(workspace, 'src', 'ledger.js');
  const before = await readFile(sourcePath, 'utf8');
  const initial = await runNode(workspace, ['--test']);
  const trace = await runProbe(workspace);
  await mkdir(path.join(workspace, '.tracepilot'), { recursive: true });
  await writeFile(
    path.join(workspace, '.tracepilot', 'race-evidence.json'),
    `${JSON.stringify(trace, null, 2)}\n`,
    'utf8',
  );
  const agent = options.agentScript
    ? await runNode(workspace, [path.resolve(options.agentScript), workspace])
    : await runGemini(options, workspace);
  const after = await readFile(sourcePath, 'utf8');
  const changedFiles = before === after ? [] : ['src/ledger.js'];
  const retry = await runNode(workspace, ['--test']);
  const stress = await runStress(workspace, options.stressRuns);
  const repairedTrace = await runProbe(workspace);
  const ok =
    initial.exitCode !== 0 &&
    trace.rootCause === 'non_atomic_check_then_commit' &&
    agent.exitCode === 0 &&
    changedFiles.length === 1 &&
    retry.exitCode === 0 &&
    stress.failures === 0 &&
    repairedTrace.observedSettlements === 1;
  const report = {
    ok,
    benchmark: 'idempotency-race',
    proofLevel: options.agentScript
      ? 'controlled_trace_assisted'
      : 'live_local_trace_assisted',
    strictLiveProof: false,
    competitorClaimsMeasured: false,
    initialTest: summarize(initial),
    traceEvidence: trace,
    agent: {
      mode: options.agentScript ? 'controlled' : 'gemini',
      model: options.agentScript ? undefined : options.model,
      ...summarize(agent),
    },
    repair: {
      changedFiles,
      onlyExpectedFilesChanged:
        changedFiles.length === 1 && changedFiles[0] === 'src/ledger.js',
    },
    retryTest: summarize(retry),
    stressVerification: stress,
    repairedTrace,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(
    `INITIAL_FIXTURE_TEST: ${initial.exitCode === 0 ? 'UNEXPECTED_PASS' : 'FAIL (expected)'}`,
  );
  console.log(
    `TRACE_EVIDENCE: ${trace.rootCause} misses_before_commit=${trace.missesBeforeFirstCommit} settlements=${trace.observedSettlements}`,
  );
  console.log(`AGENT_REPAIR: ${agent.exitCode === 0 ? 'PASS' : 'FAIL'}`);
  console.log(
    `FILES_CHANGED: ${changedFiles.length === 1 ? 'PASS' : 'FAIL'} count=${changedFiles.length}`,
  );
  console.log(`RETRY_TEST: ${retry.exitCode === 0 ? 'PASS' : 'FAIL'}`);
  console.log(
    `STRESS_VERIFICATION: ${stress.failures === 0 ? 'PASS' : 'FAIL'} runs=${stress.runs}`,
  );
  console.log(`PROOF_LEVEL: ${report.proofLevel} strictLiveProof=false`);
  console.log(`REPORT: ${output}`);
  return ok ? 0 : 1;
}

async function runGemini(
  options: Options,
  workspace: string,
): Promise<CommandResult> {
  const prompt = [
    options.task ? `User repair request: ${options.task}` : undefined,
    'Repair the duplicate-delivery settlement invariant in this service.',
    'Run npm test to reproduce the generic failure.',
    'Read .tracepilot/race-evidence.json and use the observed interleaving to identify the root cause.',
    'Apply the smallest source-only repair under src without changing tests or trace evidence.',
    'Rerun npm test and complete the work rather than only explaining it.',
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  return runNode(
    workspace,
    [
      options.cliPath,
      '--prompt',
      prompt,
      '--approval-mode=yolo',
      '--sandbox=false',
      '--skip-trust',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
    ],
    15 * 60 * 1000,
  );
}

async function runProbe(workspace: string) {
  const result = await runNode(workspace, [
    path.resolve('scripts/testing/idempotency-race-probe.mjs'),
    workspace,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Trace probe failed.');
  }
  return JSON.parse(result.stdout) as {
    rootCause: string;
    observedSettlements: number;
    missesBeforeFirstCommit: number;
    trace: unknown[];
  };
}

async function runStress(workspace: string, runs: number) {
  let failures = 0;
  for (let index = 0; index < runs; index++) {
    const result = await runNode(workspace, ['--test']);
    if (result.exitCode !== 0) {
      failures += 1;
    }
  }
  return { runs, failures, passed: runs - failures };
}

async function runNode(
  cwd: string,
  args: string[],
  timeout = 5 * 60 * 1000,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
    });
    return {
      command: `node ${args.join(' ')}`,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      command: `node ${args.join(' ')}`,
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? String(error),
    };
  }
}

function summarize(result: CommandResult) {
  const preview = createRedactedOutputPreview(
    `${result.stdout}\n${result.stderr}`,
  );
  return {
    command: result.command,
    exitCode: result.exitCode,
    outputPreview: preview.preview,
    outputSha256: preview.sha256,
  };
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    workdir: path.join(tmpdir(), 'tracepilot-idempotency-race'),
    output: '.ai-logs/idempotency-race/result.json',
    envFile: path.resolve('.env'),
    cliPath: path.resolve('packages/cli/dist/index.js'),
    model: 'gemini-3.1-flash-lite-preview',
    stressRuns: 20,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1];
    if (argv[index] === '--workdir' && value) options.workdir = value;
    if (argv[index] === '--output' && value) options.output = value;
    if (argv[index] === '--env-file' && value)
      options.envFile = path.resolve(value);
    if (argv[index] === '--cli-path' && value)
      options.cliPath = path.resolve(value);
    if (argv[index] === '--model' && value) options.model = value;
    if (argv[index] === '--task' && value) options.task = value;
    if (argv[index] === '--agent-script' && value) options.agentScript = value;
    if (argv[index] === '--stress-runs' && value)
      options.stressRuns = Number.parseInt(value, 10);
  }
  return options;
}

process.exitCode = await main(process.argv.slice(2));
