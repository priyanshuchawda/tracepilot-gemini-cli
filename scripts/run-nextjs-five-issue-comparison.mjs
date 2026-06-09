#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });

const repoRoot = process.cwd();
const phaseRoot = path.resolve('.ai-logs/tracepilot-independent-eval/phase3-nextjs-five');
const manifestPath = path.join(phaseRoot, 'candidate-issues.json');
const reproRoot = path.join(phaseRoot, 'repros');
const runRoot = path.join(phaseRoot, 'agent-runs', timestamp());
const cliPath = path.resolve('packages/cli/dist/index.js');
const model = process.env.TRACEPILOT_BENCHMARK_MODEL ?? 'gemini-3.1-flash-lite-preview';
const timeoutMs = Number.parseInt(process.env.TRACEPILOT_BENCHMARK_TIMEOUT_MS ?? '300000', 10);
const maxIssues = Number.parseInt(process.env.TRACEPILOT_BENCHMARK_MAX_ISSUES ?? '5', 10);
const arms = (process.env.TRACEPILOT_BENCHMARK_ARMS ?? 'blind,tracepilot')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item === 'blind' || item === 'tracepilot');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
await mkdir(reproRoot, { recursive: true });
await mkdir(runRoot, { recursive: true });

const prepared = [];
for (const issue of manifest.issues.slice(0, maxIssues)) {
  // Use localDir for pre-existing Phase 2 repros; otherwise clone to reproRoot
  const source = issue.localDir
    ? path.resolve(phaseRoot, issue.localDir)
    : path.join(reproRoot, issue.id);
  const prepStartedAt = new Date().toISOString();
  const clone = await ensureClone(issue, source);
  const install = await installDependencies(issue, source);
  const verifier = verifierFor(issue);
  const before = await runVerifier(source, verifier);
  prepared.push({
    ...issue,
    source,
    verifier,
    preparation: {
      startedAt: prepStartedAt,
      endedAt: new Date().toISOString(),
      clone: summarizeRun(clone),
      install: summarizeRun(install),
      reproduced: before.exitCode !== 0,
      before: summarizeRun(before),
    },
  });
  console.log(
    `ISSUE_PREPARED ${issue.id} reproduced=${before.exitCode !== 0} verifier=${renderCommand(verifier)}`,
  );
}

const benchmarkIssues = prepared.filter((issue) => issue.preparation.reproduced);
const results = [];
for (const benchmark of benchmarkIssues) {
  for (const arm of arms) {
    const workspace = path.join(runRoot, benchmark.id, arm);
    await rm(workspace, { recursive: true, force: true });
    await copyWorkspace(benchmark.source, workspace);
    const before = await runVerifier(workspace, benchmark.verifier);
    const sessionId = `tracepilot-nextjs-five-${benchmark.id}-${arm}-${Date.now()}`;
    const agent = await runAgent({
      workspace,
      arm,
      prompt: promptFor(benchmark),
      sessionId,
    });
    const after = await runVerifier(workspace, benchmark.verifier);
    const changedFiles = await listChangedFiles(benchmark.source, workspace);
    const result = {
      benchmarkId: benchmark.id,
      issueUrl: benchmark.issue,
      issueTitle: benchmark.title,
      arm,
      workspace,
      sessionId,
      model,
      verifierCommand: renderCommand(benchmark.verifier),
      before: summarizeRun(before),
      agent: summarizeRun(agent),
      after: summarizeRun(after),
      fixed: before.exitCode !== 0 && after.exitCode === 0,
      changedFiles,
      summary: summarizeAgentWork(changedFiles, agent, before, after),
      metrics: {
        repairSuccess: before.exitCode !== 0 && after.exitCode === 0,
        verificationSuccess: after.exitCode === 0,
        repairTimeMs: agent.durationMs,
        retriesRequired: countVerifierRuns(agent.stdout, benchmark.verifier),
        phoenixEvidenceAccess: arm === 'tracepilot',
        phoenixEvidenceMentioned:
          /tracepilot|phoenix|mcp|self[- ]?introspection|session|span/i.test(agent.stdout) ||
          /tracepilot|phoenix|mcp|self[- ]?introspection|session|span/i.test(agent.stderr),
      },
      timeline: {
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        durationMs: agent.durationMs,
      },
    };
    results.push(result);
    await writeFile(
      path.join(workspace, '.tracepilot-agent-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(
      `BENCHMARK_RESULT ${benchmark.id} ${arm} fixed=${result.fixed} start=${result.timeline.startedAt} end=${result.timeline.endedAt} durationMs=${agent.durationMs}`,
    );
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runRoot,
  model,
  timeoutMs,
  selectedIssueCount: prepared.length,
  reproducedIssueCount: benchmarkIssues.length,
  fairness: {
    sameCliPath: cliPath,
    sameModel: model,
    sameTimeoutMs: timeoutMs,
    sameVerifierPerIssue: true,
    treatmentDifference:
      'blind arm removes Phoenix env; TracePilot arm keeps Phoenix/MCP telemetry and trace evidence.',
  },
  issues: prepared.map((issue) => ({
    id: issue.id,
    issueUrl: issue.issue,
    title: issue.title,
    repo: issue.repo,
    status: issue.status,
    verifierCommand: renderCommand(issue.verifier),
    preparation: issue.preparation,
  })),
  summary: summarize(results),
  results,
};

const output = path.join(runRoot, 'comparison-report.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(path.join(phaseRoot, 'latest-agent-comparison.txt'), `${output}\n`, 'utf8');
console.log(`COMPARISON_REPORT: ${output}`);

async function ensureClone(issue, target) {
  // Local repros: already present, no clone needed
  if (issue.repo === 'local' && issue.localDir) {
    return {
      exitCode: 0,
      stdout: `Using pre-existing local repro at ${target}`,
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
  }
  try {
    await stat(path.join(target, '.git'));
    return {
      exitCode: 0,
      stdout: `Already cloned at ${target}`,
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
  } catch {
    await rm(target, { recursive: true, force: true });
    return runCommand(repoRoot, gitCommand(), ['clone', '--depth', '1', issue.repo, target], 600000, process.env);
  }
}

function installDependencies(issue, cwd) {
  // Phase 2 repros already have node_modules installed; skip install
  if (issue.repo === 'local' && issue.localDir) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'Skipped: local repro already has node_modules installed.',
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    });
  }
  if (issue.id === 'next-71613') {
    return runCommand(path.join(cwd, 'my-app'), bunCommand(), ['install'], 600000, process.env);
  }
  if (issue.id === 'next-75817') {
    return runCommand(cwd, corepackCommand(), ['pnpm@10.4.1', 'install', '--frozen-lockfile=false'], 600000, process.env);
  }
  if (issue.id === 'next-76103') {
    return runCommand(cwd, npmCommand(), ['install'], 600000, process.env);
  }
  return runCommand(cwd, npmCommand(), ['install'], 600000, process.env);
}

function verifierFor(issue) {
  // next-70213: custom verifier script (starts a Next.js server and checks headers)
  if (issue.id === 'next-70213') return [process.execPath, ['verify-cache-control.mjs']];
  // next-73796: npm run build fails with ERR_MODULE_NOT_FOUND
  if (issue.id === 'next-73796') return [npmCommand(), ['run', 'build']];
  // next-59950: npm run build fails with TypeScript ResolvedMetadata type error
  if (issue.id === 'next-59950') return [npmCommand(), ['run', 'build']];
  // Legacy issue IDs preserved for compatibility
  if (issue.id === 'next-75817') return [corepackCommand(), ['pnpm@10.4.1', 'build']];
  if (issue.id === 'next-76103') return [npxCommand(), ['next', 'build']];
  if (issue.id === 'next-71613') return [bunCommand(), ['run', 'build'], path.join('my-app')];
  return [npmCommand(), ['run', 'build']];
}

function promptFor(issue) {
  return [
    'You are repairing a real closed Next.js issue repro.',
    `Issue: ${issue.issue}`,
    `Title: ${issue.title}.`,
    `Verifier: ${renderCommand(issue.verifier)}.`,
    'First run the verifier and inspect the failure.',
    'Repair the smallest necessary code in this repro workspace so the verifier passes.',
    'Do not fake the verifier, do not delete the app, do not only explain.',
    'If TracePilot Phoenix/MCP trace evidence is attached to failed tool results, use it explicitly in your diagnosis.',
  ].join(' ');
}

async function copyWorkspace(source, target) {
  await cp(source, target, {
    recursive: true,
    filter: (item) => !['.git', '.next', 'coverage', 'dist', 'out'].includes(path.basename(item)),
  });
}

async function runAgent({ workspace, arm, prompt, sessionId }) {
  const home = path.join(runRoot, '.homes', `${arm}-${randomUUID()}`);
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await writeFile(
    path.join(home, '.gemini', 'settings.json'),
    `${JSON.stringify({ tools: { shell: { enableInteractiveShell: false } } }, null, 2)}\n`,
    'utf8',
  );
  const env = {
    ...process.env,
    GEMINI_CLI_HOME: home,
    GEMINI_CLI_NO_RELAUNCH: 'true',
    GEMINI_TELEMETRY_ENABLED: 'true',
    GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
  };
  if (arm === 'blind') {
    for (const key of Object.keys(env)) {
      if (key.startsWith('PHOENIX')) delete env[key];
    }
  }
  return runCommand(
    workspace,
    process.execPath,
    [
      cliPath,
      '--prompt',
      prompt,
      '--session-id',
      sessionId,
      '--approval-mode=yolo',
      '--sandbox=false',
      '--skip-trust',
      '--model',
      model,
      '--output-format',
      'stream-json',
    ],
    timeoutMs,
    env,
  );
}

function runVerifier(workspace, verifier) {
  const [command, args, subdir = '.'] = verifier;
  return runCommand(path.join(workspace, subdir), command, args, 240000, process.env);
}

function runCommand(cwd, command, args, timeout, env) {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: process.platform === 'win32' && command.endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${String(error)}`,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        timedOut: signal !== null,
      });
    });
  });
}

function summarizeRun(run) {
  const combined = `${run.stdout}\n${run.stderr}`;
  return {
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    timedOut: Boolean(run.timedOut),
    outputSha256: sha256(combined),
    outputPreview: combined.trim().slice(0, 6000),
  };
}

function summarizeAgentWork(changedFiles, agent, before, after) {
  if (before.exitCode === 0) return 'Verifier already passed before repair; excluded by scoring.';
  if (after.exitCode === 0) {
    return `Verifier passed after repair. Changed files: ${changedFiles.join(', ') || 'none recorded'}.`;
  }
  if (agent.timedOut) return 'Agent timed out before producing a passing verifier.';
  if (changedFiles.length > 0) return `Agent edited ${changedFiles.join(', ')} but verifier still failed.`;
  return 'Agent did not land a patch that changed the verifier outcome.';
}

function countVerifierRuns(output, verifier) {
  const command = renderCommand(verifier).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (output.match(new RegExp(command, 'g')) ?? []).length;
}

async function listChangedFiles(source, target) {
  const sourceFiles = await fileMap(source);
  const targetFiles = await fileMap(target);
  return [...new Set([...sourceFiles.keys(), ...targetFiles.keys()])]
    .filter((file) => sourceFiles.get(file) !== targetFiles.get(file))
    .filter((file) => file !== '.tracepilot-agent-result.json')
    .sort();
}

async function fileMap(root, current = '') {
  const files = new Map();
  let entries;
  try {
    entries = await readdir(path.join(root, current));
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (['node_modules', '.git', '.next', '.tracepilot', 'coverage', 'dist', 'out'].includes(entry)) continue;
    const relative = path.join(current, entry);
    const full = path.join(root, relative);
    const info = await stat(full);
    if (info.isDirectory()) {
      for (const [file, content] of await fileMap(root, relative)) files.set(file, content);
    } else {
      try {
        files.set(relative.replaceAll('\\', '/'), await readFile(full, 'utf8'));
      } catch {
        files.set(relative.replaceAll('\\', '/'), '<binary>');
      }
    }
  }
  return files;
}

function summarize(results) {
  const byArm = Object.fromEntries(
    arms.map((arm) => {
      const armResults = results.filter((result) => result.arm === arm);
      return [
        arm,
        {
          total: armResults.length,
          fixed: armResults.filter((result) => result.fixed).length,
          phoenixEvidenceMentioned: armResults.filter((result) => result.metrics.phoenixEvidenceMentioned).length,
          totalRepairTimeMs: armResults.reduce((sum, result) => sum + result.metrics.repairTimeMs, 0),
        },
      ];
    }),
  );
  const advantages = resultsByIssue(results).map(([id, items]) => {
    const blind = items.find((item) => item.arm === 'blind');
    const tracepilot = items.find((item) => item.arm === 'tracepilot');
    return {
      id,
      outcome:
        !blind?.fixed && tracepilot?.fixed
          ? 'tracepilot_only'
          : blind?.fixed && tracepilot?.fixed
            ? 'both_fixed'
            : blind?.fixed && !tracepilot?.fixed
              ? 'blind_only'
              : 'both_missed',
    };
  });
  return { byArm, advantages };
}

function resultsByIssue(results) {
  const map = new Map();
  for (const result of results) map.set(result.benchmarkId, [...(map.get(result.benchmarkId) ?? []), result]);
  return [...map.entries()];
}

function renderCommand([command, args, subdir]) {
  const prefix = subdir && subdir !== '.' ? `(cd ${subdir}) ` : '';
  return `${prefix}${[command, ...args].join(' ')}`;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function corepackCommand() {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
}

function bunCommand() {
  // On Windows, bun is installed as bun.cmd via npm (not bun.exe in PATH)
  return process.platform === 'win32' ? 'bun.cmd' : 'bun';
}

function gitCommand() {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
