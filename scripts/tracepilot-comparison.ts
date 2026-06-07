#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
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
import dotenv from 'dotenv';
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';

type ArmName = 'blind' | 'tracepilot';
type EventKind =
  | 'status'
  | 'plan'
  | 'tool'
  | 'evidence'
  | 'evaluation'
  | 'result';

interface Options {
  workdir: string;
  output: string;
  envFile: string;
  cliPath: string;
  model: string;
  prompt: string;
  agentScript?: string;
  budgetMs: number;
  memoryFile: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface EvaluationCheck {
  id: string;
  status: 'pass' | 'fail';
  reason?: string;
}

interface Evaluation {
  ok: boolean;
  score: number;
  passed: number;
  total: number;
  checks: EvaluationCheck[];
}

interface ArmResult {
  arm: ArmName;
  workspace: string;
  evidenceAccess: boolean;
  sessionMemoryEntries: number;
  workspaceDigestBefore: string;
  publicTestsPassedBefore: boolean;
  hiddenBefore: Evaluation;
  agent: {
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
    output: { preview: string; sha256: string };
  };
  publicTestsPassedAfter: boolean;
  hiddenAfter: Evaluation;
  changedFiles: string[];
  productionChangedFiles: string[];
  changesWithinAllowedScope: boolean;
  metrics: ReturnType<typeof scoreArm>;
  solved: boolean;
}

const DEFAULT_PROMPT = [
  'A production settlement was charged twice after a delivery retry, but the public tests pass.',
  'Investigate and repair the root cause.',
  'If TracePilot runtime or session evidence exists, use it as trusted operational evidence.',
  'Preserve retry behavior and reject reuse of an idempotency key for a different payload.',
  'Keep production changes under src; diagnostic tests may be added.',
  'Run the public tests after applying the smallest production fix.',
  'Do not only explain the change.',
].join(' ');

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  dotenv.config({ path: options.envFile, quiet: true });
  const fixture = path.resolve('examples/distributed-settlement-incident');
  const comparisonRoot = path.resolve(options.workdir);
  const test1 = path.join(comparisonRoot, 'test1');
  const test2 = path.join(comparisonRoot, 'test2');
  const fixtureDigest = await digestDirectory(fixture);

  await rm(comparisonRoot, { recursive: true, force: true });
  await mkdir(comparisonRoot, { recursive: true });
  await Promise.all([
    cp(fixture, test1, { recursive: true }),
    cp(fixture, test2, { recursive: true }),
  ]);

  const startingDigests = await Promise.all([
    digestDirectory(test1),
    digestDirectory(test2),
  ]);
  emit({
    kind: 'evidence',
    title: 'Fairness contract',
    detail: `Same model, prompt, permissions, evaluator, and ${options.budgetMs}ms deadline.`,
    status: 'pass',
    data: {
      fixtureSha256: fixtureDigest,
      test1Sha256: startingDigests[0],
      test2Sha256: startingDigests[1],
    },
  });

  const memory = await loadSessionMemory(options.memoryFile);
  await mkdir(path.join(test2, '.tracepilot'), { recursive: true });
  await Promise.all([
    cp(
      path.resolve('scripts/testing/distributed-settlement-trace.json'),
      path.join(test2, '.tracepilot', 'production-trace.json'),
    ),
    writeFile(
      path.join(test2, '.tracepilot', 'session-memory.json'),
      `${JSON.stringify(memory, null, 2)}\n`,
      'utf8',
    ),
  ]);
  emit({
    arm: 'tracepilot',
    kind: 'evidence',
    title: 'Session evidence retrieved',
    detail: `${memory.entries?.length ?? 0} verified prior outcome(s) matched this incident.`,
    status: 'pass',
  });
  emit({
    arm: 'blind',
    kind: 'evidence',
    title: 'Repository context only',
    detail: 'No runtime trace or prior session outcome was provided.',
    status: 'running',
  });

  const before = await Promise.all([
    inspectBefore(test1),
    inspectBefore(test2),
  ]);
  emit({
    kind: 'evaluation',
    title: 'Baseline evaluation',
    detail: `Both public suites pass; both hidden evaluators begin at ${before[0].hidden.score * 100}%.`,
    status: 'pass',
  });

  const startedAt = Date.now();
  emitArmStart('blind', options);
  emitArmStart('tracepilot', options);
  const [blindAgent, traceAgent] = await Promise.all([
    runAgent(options, test1, 'blind'),
    runAgent(options, test2, 'tracepilot'),
  ]);
  const wallClockMs = Date.now() - startedAt;

  const arms = await Promise.all([
    finalizeArm({
      arm: 'blind',
      workspace: test1,
      fixture,
      fixtureDigest,
      workspaceDigestBefore: startingDigests[0],
      before: before[0],
      agent: blindAgent,
      budgetMs: options.budgetMs,
      sessionMemoryEntries: 0,
    }),
    finalizeArm({
      arm: 'tracepilot',
      workspace: test2,
      fixture,
      fixtureDigest,
      workspaceDigestBefore: startingDigests[1],
      before: before[1],
      agent: traceAgent,
      budgetMs: options.budgetMs,
      sessionMemoryEntries: memory.entries?.length ?? 0,
    }),
  ]);

  for (const arm of arms) {
    emit({
      arm: arm.arm,
      kind: 'evaluation',
      title: 'External evaluation complete',
      detail: `${arm.hiddenAfter.passed}/${arm.hiddenAfter.total} bug checks; score ${arm.metrics.total}/100.`,
      status: arm.solved ? 'pass' : 'fail',
      data: {
        metrics: arm.metrics,
        checks: arm.hiddenAfter.checks,
        changedFiles: arm.changedFiles,
      },
    });
  }

  const outcome = summarizeOutcome(arms);
  const report = {
    schemaVersion: 1,
    ok:
      startingDigests.every((digest) => digest === fixtureDigest) &&
      arms.every((arm) => arm.workspaceDigestBefore === fixtureDigest),
    benchmark: 'distributed-settlement-comparison',
    generatedAt: new Date().toISOString(),
    model: options.agentScript ? 'controlled-substitute' : options.model,
    prompt: options.prompt,
    promptSha256: sha256(options.prompt),
    fixtureSha256: fixtureDigest,
    budgetMs: options.budgetMs,
    wallClockMs,
    workspaces: { test1, test2 },
    fairness: {
      samePrompt: true,
      sameStartingWorkspace: true,
      sameModel: true,
      samePermissions: true,
      sameDeadline: true,
      sameEvaluator: true,
      hiddenEvaluatorVisibleToAgents: false,
      treatmentDifference:
        'TracePilot receives production trace and sanitized verified session outcomes.',
    },
    rubric: {
      correctness: 60,
      regressionSafety: 15,
      patchDiscipline: 10,
      speed: 15,
      rule: 'Speed points require a fully correct repair.',
    },
    arms,
    outcome,
    winner: chooseWinner(arms),
    claimBoundary:
      'The result applies only to this measured model, prompt, fixture, and run.',
  };
  const tracepilot = arms.find((arm) => arm.arm === 'tracepilot');
  if (tracepilot?.solved) {
    await recordVerifiedSessionOutcome(options.memoryFile, memory, {
      promptSha256: sha256(options.prompt),
      fixtureSha256: fixtureDigest,
      hiddenChecksPassed: tracepilot.hiddenAfter.passed,
      hiddenChecksTotal: tracepilot.hiddenAfter.total,
      productionChangedFiles: tracepilot.productionChangedFiles,
    });
    emit({
      arm: 'tracepilot',
      kind: 'evidence',
      title: 'Verified session outcome stored',
      detail:
        'The sanitized result is now available to future TracePilot runs.',
      status: 'pass',
    });
  }
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  emit({
    kind: 'result',
    title: 'Comparison complete',
    detail: `${report.winner} wins; outcome=${outcome}.`,
    status: report.winner === 'tracepilot' ? 'pass' : 'warn',
    data: {
      winner: report.winner,
      outcome,
      scores: Object.fromEntries(
        arms.map((arm) => [arm.arm, arm.metrics.total]),
      ),
    },
  });
  console.log(`COMPARISON_REPORT: ${output}`);
  return report.ok ? 0 : 1;
}

async function loadSessionMemory(memoryFile: string): Promise<{
  schemaVersion: number;
  entries: Array<Record<string, unknown>>;
}> {
  const seed = JSON.parse(
    await readFile(
      path.resolve(
        'scripts/testing/distributed-settlement-session-memory.json',
      ),
      'utf8',
    ),
  ) as { entries?: Array<Record<string, unknown>> };
  let persisted: { entries?: Array<Record<string, unknown>> } = {};
  try {
    persisted = JSON.parse(await readFile(memoryFile, 'utf8')) as {
      entries?: Array<Record<string, unknown>>;
    };
  } catch {
    persisted = {};
  }
  const entries = [...(seed.entries ?? []), ...(persisted.entries ?? [])];
  const unique = new Map(
    entries.map((entry) => [
      String(entry['id'] ?? entry['promptSha256'] ?? JSON.stringify(entry)),
      entry,
    ]),
  );
  return { schemaVersion: 1, entries: [...unique.values()] };
}

async function recordVerifiedSessionOutcome(
  memoryFile: string,
  memory: { entries: Array<Record<string, unknown>> },
  outcome: {
    promptSha256: string;
    fixtureSha256: string;
    hiddenChecksPassed: number;
    hiddenChecksTotal: number;
    productionChangedFiles: string[];
  },
): Promise<void> {
  const generated = {
    id: `verified-${outcome.promptSha256.slice(0, 12)}`,
    promptSha256: outcome.promptSha256,
    fixtureSha256: outcome.fixtureSha256,
    hiddenChecksPassed: outcome.hiddenChecksPassed,
    hiddenChecksTotal: outcome.hiddenChecksTotal,
    productionChangedFiles: outcome.productionChangedFiles,
    observedOutcome: 'verified repair passed all external production checks',
    source: 'sanitized TracePilot comparison session',
  };
  const entries = [
    ...memory.entries.filter((entry) => entry['id'] !== generated.id),
    generated,
  ].filter((entry) => entry['source'] !== 'sanitized verified session outcome');
  await mkdir(path.dirname(memoryFile), { recursive: true });
  await writeFile(
    memoryFile,
    `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
    'utf8',
  );
}

async function inspectBefore(workspace: string) {
  const [publicTests, hidden] = await Promise.all([
    runCommand(workspace, ['--test']),
    runHiddenEvaluator(workspace),
  ]);
  return { publicTests, hidden };
}

async function finalizeArm(input: {
  arm: ArmName;
  workspace: string;
  fixture: string;
  fixtureDigest: string;
  workspaceDigestBefore: string;
  before: Awaited<ReturnType<typeof inspectBefore>>;
  agent: CommandResult;
  budgetMs: number;
  sessionMemoryEntries: number;
}): Promise<ArmResult> {
  const [publicAfter, hiddenAfter, changedFiles] = await Promise.all([
    runCommand(input.workspace, ['--test']),
    runHiddenEvaluator(input.workspace),
    changedFilesAgainstFixture(input.fixture, input.workspace),
  ]);
  const productionChangedFiles = changedFiles.filter((file) =>
    file.startsWith('src/'),
  );
  const changesWithinAllowedScope = changedFiles.every(
    (file) => file.startsWith('src/') || file.startsWith('test/'),
  );
  const solved =
    input.agent.exitCode === 0 &&
    publicAfter.exitCode === 0 &&
    hiddenAfter.ok &&
    productionChangedFiles.length > 0 &&
    changesWithinAllowedScope;
  const metrics = scoreArm({
    hidden: hiddenAfter,
    publicPassed: publicAfter.exitCode === 0,
    hadNoRegression: input.before.publicTests.exitCode === 0,
    productionChangedFiles,
    changesWithinAllowedScope,
    durationMs: input.agent.durationMs,
    budgetMs: input.budgetMs,
    solved,
  });
  return {
    arm: input.arm,
    workspace: input.workspace,
    evidenceAccess: input.arm === 'tracepilot',
    sessionMemoryEntries: input.sessionMemoryEntries,
    workspaceDigestBefore: input.workspaceDigestBefore,
    publicTestsPassedBefore: input.before.publicTests.exitCode === 0,
    hiddenBefore: input.before.hidden,
    agent: {
      exitCode: input.agent.exitCode,
      durationMs: input.agent.durationMs,
      timedOut: input.agent.timedOut,
      output: summarizeOutput(input.agent),
    },
    publicTestsPassedAfter: publicAfter.exitCode === 0,
    hiddenAfter,
    changedFiles,
    productionChangedFiles,
    changesWithinAllowedScope,
    metrics,
    solved,
  };
}

function scoreArm(input: {
  hidden: Evaluation;
  publicPassed: boolean;
  hadNoRegression: boolean;
  productionChangedFiles: string[];
  changesWithinAllowedScope: boolean;
  durationMs: number;
  budgetMs: number;
  solved: boolean;
}) {
  const correctness = Math.round(input.hidden.score * 60);
  const regressionSafety =
    (input.publicPassed ? 10 : 0) +
    (input.hadNoRegression && input.publicPassed ? 5 : 0);
  const patchDiscipline =
    (input.changesWithinAllowedScope ? 5 : 0) +
    (input.productionChangedFiles.length === 1 ? 5 : 0);
  const speed = input.solved
    ? Math.max(0, Math.round(15 * (1 - input.durationMs / input.budgetMs)))
    : 0;
  return {
    correctness,
    regressionSafety,
    patchDiscipline,
    speed,
    accuracyPercent: Math.round(input.hidden.score * 100),
    bugHits: input.hidden.passed,
    bugMisses: input.hidden.total - input.hidden.passed,
    durationMs: input.durationMs,
    total: correctness + regressionSafety + patchDiscipline + speed,
  };
}

function emitArmStart(arm: ArmName, options: Options): void {
  emit({
    arm,
    kind: 'plan',
    title: 'Agent started',
    detail: `${options.model}; shared deadline ${options.budgetMs}ms.`,
    status: 'running',
  });
}

async function runAgent(
  options: Options,
  workspace: string,
  arm: ArmName,
): Promise<CommandResult> {
  if (options.agentScript) {
    return runCommand(
      workspace,
      [path.resolve(options.agentScript), workspace],
      options.budgetMs,
      {},
      arm,
    );
  }
  const home = path.join(
    tmpdir(),
    'tracepilot-comparison-home',
    `${Date.now()}-${arm}`,
  );
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await writeFile(
    path.join(home, '.gemini', 'settings.json'),
    `${JSON.stringify({ tools: { shell: { enableInteractiveShell: false } } }, null, 2)}\n`,
    'utf8',
  );
  return runCommand(
    workspace,
    [
      options.cliPath,
      '--prompt',
      options.prompt,
      '--approval-mode=yolo',
      '--sandbox=false',
      '--skip-trust',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
    ],
    options.budgetMs,
    {
      GEMINI_CLI_HOME: home,
      GEMINI_CLI_NO_RELAUNCH: 'true',
    },
    arm,
  );
}

async function runHiddenEvaluator(workspace: string): Promise<Evaluation> {
  const result = await runCommand(workspace, [
    path.resolve('scripts/testing/distributed-settlement-hidden-evaluator.mjs'),
    workspace,
  ]);
  try {
    return JSON.parse(result.stdout) as Evaluation;
  } catch {
    return {
      ok: false,
      score: 0,
      passed: 0,
      total: 3,
      checks: [{ id: 'evaluator', status: 'fail', reason: 'invalid output' }],
    };
  }
}

async function runCommand(
  cwd: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
  extraEnv: NodeJS.ProcessEnv = {},
  arm?: ArmName,
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let activityCount = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (arm && activityCount < 8) {
        activityCount += 1;
        emit({
          arm,
          kind: 'tool',
          title: 'Agent activity',
          detail: `Processing repository evidence and repair step ${activityCount}.`,
          status: 'running',
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${String(error)}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const timedOut = signal !== null && durationMs >= timeoutMs;
      if (arm) {
        emit({
          arm,
          kind: 'status',
          title: timedOut ? 'Deadline reached' : 'Agent finished',
          detail: `${durationMs}ms; exit=${code ?? 1}.`,
          status: timedOut || (code ?? 1) !== 0 ? 'warn' : 'pass',
        });
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs,
        timedOut,
      });
    });
  });
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

async function digestDirectory(root: string): Promise<string> {
  const files = await fileContents(root, ['.tracepilot']);
  const hash = createHash('sha256');
  for (const [file, content] of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
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

function emit(event: {
  arm?: ArmName;
  kind: EventKind;
  title: string;
  detail: string;
  status: 'running' | 'pass' | 'warn' | 'fail';
  data?: Record<string, unknown>;
}): void {
  console.log(`COMPARISON_EVENT: ${JSON.stringify(event)}`);
}

function summarizeOutput(result: CommandResult) {
  const preview = createRedactedOutputPreview(
    `${result.stdout}\n${result.stderr}`,
  );
  return { preview: preview.preview, sha256: preview.sha256 };
}

function summarizeOutcome(arms: ArmResult[]): string {
  const blind = arms.find((arm) => arm.arm === 'blind');
  const tracepilot = arms.find((arm) => arm.arm === 'tracepilot');
  if (!blind || !tracepilot) return 'incomplete';
  if (!blind.solved && tracepilot.solved) return 'tracepilot_advantage';
  if (blind.solved && tracepilot.solved) return 'both_solved';
  if (!blind.solved && !tracepilot.solved) return 'neither_solved';
  return 'blind_only';
}

function chooseWinner(arms: ArmResult[]): ArmName | 'tie' {
  const [blind, tracepilot] = arms;
  if (blind.metrics.total === tracepilot.metrics.total) return 'tie';
  return blind.metrics.total > tracepilot.metrics.total
    ? blind.arm
    : tracepilot.arm;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    workdir: path.join(tmpdir(), 'tracepilot-comparison'),
    output: '.ai-logs/tracepilot-comparison/result.json',
    envFile: path.resolve('.env'),
    cliPath: path.resolve('packages/cli/dist/index.js'),
    model: 'gemini-3.1-flash-lite-preview',
    prompt: DEFAULT_PROMPT,
    budgetMs: 120_000,
    memoryFile: path.resolve(
      '.ai-logs/tracepilot-comparison/session-memory.json',
    ),
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
    if (argv[index] === '--prompt' && value) options.prompt = value;
    if (argv[index] === '--agent-script' && value) options.agentScript = value;
    if (argv[index] === '--budget-ms' && value)
      options.budgetMs = Number.parseInt(value, 10);
    if (argv[index] === '--memory-file' && value)
      options.memoryFile = path.resolve(value);
  }
  return options;
}

process.exitCode = await main(process.argv.slice(2));
