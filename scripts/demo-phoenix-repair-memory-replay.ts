#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { GeminiCliOperation } from '../packages/core/src/telemetry/constants.js';
import {
  connectDirectPhoenixMcpClient,
  DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS,
  getSpanList,
  resolveDirectPhoenixMcpConfig,
  resolveTracePilotPhoenixEnv,
} from '../packages/core/src/telemetry/phoenixMcpUtils.js';
import {
  describeTracePilotProofLevel,
  isStrictTracePilotProofLevel,
  TRACEPILOT_PROOF_LEVELS,
  type TracePilotProofLevel,
} from '../packages/core/src/tracepilot/proofLevel.js';

const execFileAsync = promisify(execFile);
const PHOENIX_MCP_QUERY_TIMEOUT_MS = DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS;

interface Options {
  workdir: string;
  output: string;
  envFile: string;
  model: string;
  controlledRunnerScript?: string;
}

interface RepairSessionReport {
  ok: boolean;
  proofLevel?: TracePilotProofLevel;
  sessionId: string;
  agent: { mode: string; exitCode: number };
  repair: {
    verifiedOutcomeRecorded: boolean;
    changedFiles?: string[];
  };
  retryTest: { exitCode: number };
  eval: { ok: boolean };
  memory?: { seedSessionIds?: string[] };
}

interface MemoryMatch {
  attempted: boolean;
  matched: boolean;
  seedSessionIds: string[];
  replayPlanVisible: boolean;
  memoryRetrievalVisible?: boolean;
  simulated: boolean;
  reason?: string;
}

interface SeedOutcomeVisibility {
  attempted: boolean;
  visible: boolean;
  simulated: boolean;
  reason?: string;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  dotenv.config({ path: options.envFile, quiet: true });
  await mkdir(path.resolve(options.workdir), { recursive: true });

  const seed = await runRepairSession('seed', options);
  const seedOutcome: SeedOutcomeVisibility = options.controlledRunnerScript
    ? {
        attempted: false,
        visible: seed.repair.verifiedOutcomeRecorded,
        simulated: true,
      }
    : seed.repair.verifiedOutcomeRecorded
      ? await waitForSeedOutcome(seed.sessionId)
      : {
          attempted: false,
          visible: false,
          simulated: false,
          reason: 'Seed repair did not record a verified Phoenix outcome.',
        };
  const replay = seedOutcome.visible
    ? await runRepairSession('replay', options, seed.sessionId)
    : skippedReplay(options);
  const memory: MemoryMatch = options.controlledRunnerScript
    ? {
        attempted: false,
        matched:
          replay.memory?.seedSessionIds?.includes(seed.sessionId) ?? false,
        seedSessionIds: replay.memory?.seedSessionIds ?? [],
        replayPlanVisible: false,
        simulated: true,
      }
    : seedOutcome.visible
      ? await queryReplayMemory(replay.sessionId, seed.sessionId)
      : {
          attempted: false,
          matched: false,
          seedSessionIds: [],
          replayPlanVisible: false,
          simulated: false,
          reason:
            'Replay skipped because the verified seed outcome is not visible.',
        };
  const runOk =
    seed.ok &&
    seed.repair.verifiedOutcomeRecorded &&
    seedOutcome.visible &&
    replay.ok &&
    replay.retryTest.exitCode === 0 &&
    replay.eval.ok &&
    memory.matched;
  const proofLevel = deriveProofLevel(options, runOk, memory);
  const report = {
    ok: runOk,
    strictLiveProof: runOk && !memory.simulated,
    proofLevel,
    proofSummary: describeTracePilotProofLevel(proofLevel),
    seed,
    seedOutcome,
    replay,
    memory,
  };

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(
    path.resolve(options.output),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  printProofLines(report, options.output);
  return report.ok ? 0 : 1;
}

function deriveProofLevel(
  options: Options,
  runOk: boolean,
  memory: MemoryMatch,
): TracePilotProofLevel {
  if (options.controlledRunnerScript) {
    return TRACEPILOT_PROOF_LEVELS.CONTROLLED_SUBSTITUTE;
  }
  return runOk && !memory.simulated
    ? TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX
    : TRACEPILOT_PROOF_LEVELS.DEGRADED_GEMINI;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    workdir: path.join(tmpdir(), 'tracepilot-phoenix-repair-memory'),
    output: '.ai-logs/demo-phoenix-repair-memory/result.json',
    envFile: path.resolve('.env'),
    model: 'gemini-3.1-flash-lite-preview',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--workdir') options.workdir = argv[++index] ?? options.workdir;
    if (arg === '--output') options.output = argv[++index] ?? options.output;
    if (arg === '--env-file') {
      options.envFile = path.resolve(argv[++index] ?? options.envFile);
    }
    if (arg === '--model') options.model = argv[++index] ?? options.model;
    if (arg === '--controlled-runner-script') {
      options.controlledRunnerScript = argv[++index];
    }
  }
  return options;
}

async function runRepairSession(
  phase: 'seed' | 'replay',
  options: Options,
  seedSessionId = '',
): Promise<RepairSessionReport> {
  const resultPath = path.resolve(options.workdir, `${phase}.json`);
  const phaseWorkdir = path.resolve(options.workdir, phase);
  const args = options.controlledRunnerScript
    ? [
        path.resolve(options.controlledRunnerScript),
        '--phase',
        phase,
        '--output',
        resultPath,
        '--seed-session-id',
        seedSessionId,
      ]
    : [
        '--import',
        'tsx',
        path.resolve('scripts/demo-gemini-repair-agent.ts'),
        '--workdir',
        phaseWorkdir,
        '--output',
        resultPath,
        '--env-file',
        options.envFile,
        '--model',
        options.model,
      ];
  try {
    await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      timeout: 20 * 60 * 1000,
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    // The written child report carries the redacted reason for failed proof.
  }
  return JSON.parse(await readFile(resultPath, 'utf8')) as RepairSessionReport;
}

function skippedReplay(options: Options): RepairSessionReport {
  return {
    ok: false,
    sessionId: 'replay-skipped',
    agent: {
      mode: options.controlledRunnerScript ? 'controlled' : 'gemini',
      exitCode: 1,
    },
    repair: {
      verifiedOutcomeRecorded: false,
      changedFiles: [],
    },
    retryTest: { exitCode: 1 },
    eval: { ok: false },
  };
}

async function waitForSeedOutcome(
  seedSessionId: string,
): Promise<SeedOutcomeVisibility> {
  const directConfig = resolveDirectPhoenixMcpConfig(process.env);
  if (!directConfig) {
    const phoenixEnv = resolveTracePilotPhoenixEnv(process.env);
    return {
      attempted: false,
      visible: false,
      simulated: false,
      reason:
        phoenixEnv.mcpSkipReason ??
        'Phoenix API key, host, or project is missing.',
    };
  }
  const client = await connectDirectPhoenixMcpClient(directConfig, {
    clientName: 'tracepilot-phoenix-seed-outcome-demo',
  });
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = await client.callGetSpans(
        {
          project_identifier: directConfig.project,
          start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          names: [GeminiCliOperation.RepairReport],
          session_id: seedSessionId,
          limit: 20,
        },
        PHOENIX_MCP_QUERY_TIMEOUT_MS,
      );
      if (result.error) {
        return {
          attempted: true,
          visible: false,
          simulated: false,
          reason: `Phoenix seed-outcome query failed: ${result.error.message}`,
        };
      }
      const visible = getSpanList(result.data ?? result.llmContent).some(
        (span) =>
          getRecord(span.attributes)?.['session.id'] === seedSessionId &&
          getRecord(span.attributes)?.[
            'gemini_cli.repair.verification_passed'
          ] === true,
      );
      if (visible) {
        return { attempted: true, visible: true, simulated: false };
      }
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    return {
      attempted: true,
      visible: false,
      simulated: false,
      reason: 'Phoenix MCP did not return the verified seed outcome in time.',
    };
  } catch (error) {
    return {
      attempted: true,
      visible: false,
      simulated: false,
      reason: `Phoenix seed-outcome query failed: ${getErrorMessage(error)}`,
    };
  } finally {
    await client.close();
  }
}

async function queryReplayMemory(
  replaySessionId: string,
  seedSessionId: string,
): Promise<MemoryMatch> {
  const directConfig = resolveDirectPhoenixMcpConfig(process.env);
  if (!directConfig) {
    const phoenixEnv = resolveTracePilotPhoenixEnv(process.env);
    return {
      attempted: false,
      matched: false,
      seedSessionIds: [],
      replayPlanVisible: false,
      simulated: false,
      reason:
        phoenixEnv.mcpSkipReason ??
        'Phoenix API key, host, or project is missing.',
    };
  }
  const client = await connectDirectPhoenixMcpClient(directConfig, {
    clientName: 'tracepilot-phoenix-repair-memory-demo',
  });
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = await client.callGetSpans(
        {
          project_identifier: directConfig.project,
          start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          names: [GeminiCliOperation.RepairMemoryRetrieve],
          session_id: replaySessionId,
          limit: 20,
        },
        PHOENIX_MCP_QUERY_TIMEOUT_MS,
      );
      if (result.error) {
        return {
          attempted: true,
          matched: false,
          seedSessionIds: [],
          replayPlanVisible: false,
          memoryRetrievalVisible: false,
          simulated: false,
          reason: `Phoenix memory query failed: ${result.error.message}`,
        };
      }
      const span = getSpanList(result.data ?? result.llmContent).find(
        (candidate) =>
          getRecord(candidate.attributes)?.['session.id'] === replaySessionId,
      );
      if (span) {
        const output = getRecord(span.attributes)?.['gen_ai.output.messages'];
        const seedSessionIds = extractHistoricalSessionIds(output);
        const matched = containsText(output, seedSessionId);
        return {
          attempted: true,
          matched,
          seedSessionIds,
          replayPlanVisible: true,
          memoryRetrievalVisible: true,
          simulated: false,
          reason: matched
            ? undefined
            : 'Replay repair-memory retrieval did not reference the seed repair session.',
        };
      }
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    return {
      attempted: true,
      matched: false,
      seedSessionIds: [],
      replayPlanVisible: false,
      memoryRetrievalVisible: false,
      simulated: false,
      reason:
        'Phoenix MCP did not return the replay repair-memory retrieval span in time.',
    };
  } catch (error) {
    return {
      attempted: true,
      matched: false,
      seedSessionIds: [],
      replayPlanVisible: false,
      memoryRetrievalVisible: false,
      simulated: false,
      reason: `Phoenix memory query failed: ${getErrorMessage(error)}`,
    };
  } finally {
    await client.close();
  }
}

function printProofLines(
  report: {
    ok: boolean;
    strictLiveProof: boolean;
    proofLevel: TracePilotProofLevel;
    seed: RepairSessionReport;
    seedOutcome: SeedOutcomeVisibility;
    replay: RepairSessionReport;
    memory: MemoryMatch;
  },
  output: string,
): void {
  const qualifier = report.memory.simulated ? 'SIMULATED' : 'PASS';
  console.log(
    `PROOF_LEVEL: ${report.proofLevel} strictLiveProof=${isStrictTracePilotProofLevel(report.proofLevel)}`,
  );
  console.log(
    `SEED_REPAIR: ${report.seed.ok ? 'PASS' : 'FAIL'} mode=${report.seed.agent.mode}`,
  );
  console.log(
    `VERIFIED_REPAIR_RECORDED: ${report.seed.repair.verifiedOutcomeRecorded ? qualifier : 'FAIL'}`,
  );
  console.log(
    `SEED_OUTCOME_VISIBLE: ${report.seedOutcome.visible ? qualifier : 'FAIL'}`,
  );
  console.log(
    `REPLAY_REPAIR: ${report.replay.ok ? 'PASS' : 'FAIL'} mode=${report.replay.agent.mode}`,
  );
  console.log(
    `PHOENIX_MEMORY_MATCH: ${report.memory.matched ? qualifier : 'FAIL'}`,
  );
  console.log(
    `REPLAY_RETRY_TEST: ${report.replay.retryTest.exitCode === 0 ? 'PASS' : 'FAIL'}`,
  );
  console.log(`EVALS: ${report.replay.eval.ok ? 'PASS' : 'FAIL'}`);
  console.log(`SEED_SESSION_ID: ${report.seed.sessionId}`);
  console.log(`REPLAY_SESSION_ID: ${report.replay.sessionId}`);
  console.log(`REPORT: ${output}`);
}

function containsText(value: unknown, expected: string): boolean {
  return JSON.stringify(value ?? '').includes(expected);
}

function extractHistoricalSessionIds(value: unknown): string[] {
  const parsed = deepParseJson(value);
  const record = getRecord(parsed);
  const evidence = record?.['evidence'];
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((item) => getString(getRecord(item), 'sessionId'))
    .filter((sessionId): sessionId is string => sessionId !== undefined);
}

function deepParseJson(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 3 && typeof current === 'string'; index++) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      break;
    }
  }
  return current;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
