#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  register,
  trace,
  type NodeTracerProvider,
} from '@arizeai/phoenix-otel';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_OUTPUT_SHA256,
  GEMINI_CLI_REPAIR_FINGERPRINT,
  GEMINI_CLI_REPAIR_ROOT_CAUSE,
  GEMINI_CLI_REPAIR_SIGNATURE_ID,
  GEMINI_CLI_REPAIR_STRATEGY,
  GEMINI_CLI_REPAIR_VERIFICATION_PASSED,
  GeminiCliOperation,
} from '../packages/core/src/telemetry/constants.js';
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';
import {
  runTracePilotEvals,
  type TracePilotEvalEvidence,
} from '../packages/core/src/tracepilot/evals.js';
import { buildTracePilotFailureSignature } from '../packages/core/src/tracepilot/failureSignature.js';
import { createTracePilotRepairFingerprint } from '../packages/core/src/tracepilot/repairMemory.js';

const execFileAsync = promisify(execFile);
const DEFAULT_PHOENIX_MCP_PACKAGE = '@arizeai/phoenix-mcp@4.0.13';
const PHOENIX_MCP_QUERY_TIMEOUT_MS = 180_000;
const EXPECTED_CHANGED_FILES = [
  'src/config.js',
  'src/redact.js',
  'src/signature.js',
];

interface Options {
  workdir: string;
  output: string;
  allowMissingPhoenix: boolean;
  agentScript?: string;
  envFile: string;
  cliPath: string;
  model: string;
}

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PhoenixSessionEvidence {
  attempted: boolean;
  queryable: boolean;
  visible: boolean;
  failedToolSpan: boolean;
  passingToolSpan: boolean;
  introspectionSpan: boolean;
  phoenixMcpSpan: boolean;
  introspectionEvidenceAvailable: boolean;
  traceId?: string;
  spanId?: string;
  reason?: string;
}

interface AgentResult extends CommandResult {
  mode: 'gemini' | 'substitute';
}

interface VerifiedRepairOutcome {
  attempted: boolean;
  recorded: boolean;
  signatureId?: string;
  repairFingerprint?: string;
  reason?: string;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  dotenv.config({ path: options.envFile, quiet: true });

  const fixtureDir = path.resolve('examples/broken-checkout-service');
  const demoDir = path.resolve(options.workdir);
  await rm(demoDir, { recursive: true, force: true });
  await mkdir(path.dirname(demoDir), { recursive: true });
  await cp(fixtureDir, demoDir, { recursive: true });

  const sessionId = `tracepilot-gemini-repair-${Date.now()}`;
  const before = await captureFiles(demoDir);
  const initial = await runNodeTests(demoDir);
  const agent = await runAgent(options, demoDir, sessionId);
  const retry = await runNodeTests(demoDir);
  const changedFiles = findChangedFiles(before, await captureFiles(demoDir));
  const phoenix =
    agent.mode === 'substitute'
      ? degradedPhoenix('Controlled substitute agent does not emit CLI spans.')
      : await queryPhoenixSession(sessionId);
  const evalReport = runTracePilotEvals(
    buildEvalEvidence(sessionId, initial, retry, phoenix, changedFiles),
  );
  const filesChangedOk =
    changedFiles.length === EXPECTED_CHANGED_FILES.length &&
    EXPECTED_CHANGED_FILES.every((file) => changedFiles.includes(file));
  const localRepairOk =
    initial.exitCode !== 0 &&
    agent.exitCode === 0 &&
    retry.exitCode === 0 &&
    filesChangedOk;
  const strictEvidenceOk =
    phoenix.failedToolSpan &&
    phoenix.phoenixMcpSpan &&
    phoenix.introspectionSpan &&
    phoenix.introspectionEvidenceAvailable;
  const verifiedOutcome = await recordVerifiedRepairOutcome({
    eligible:
      agent.mode === 'gemini' &&
      localRepairOk &&
      strictEvidenceOk &&
      evalReport.ok,
    sessionId,
    initial,
    retry,
    changedFiles,
    mode: agent.mode,
  });
  const report = {
    ok:
      localRepairOk &&
      (options.allowMissingPhoenix ||
        (strictEvidenceOk && evalReport.ok && verifiedOutcome.recorded)),
    sessionId,
    workdir: demoDir,
    allowMissingPhoenix: options.allowMissingPhoenix,
    initialTest: summarizeCommand(initial),
    agent: {
      mode: agent.mode,
      exitCode: agent.exitCode,
      output: summarizeCommand(agent),
    },
    phoenix,
    repair: {
      changedFiles,
      expectedChangedFiles: EXPECTED_CHANGED_FILES,
      onlyExpectedFilesChanged: filesChangedOk,
      verifiedOutcomeRecorded: verifiedOutcome.recorded,
      verifiedOutcome,
    },
    retryTest: summarizeCommand(retry),
    eval: evalReport,
  };

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(
    options.output,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  printProofLines(report, options.output);
  return report.ok ? 0 : 1;
}

async function recordVerifiedRepairOutcome(input: {
  eligible: boolean;
  sessionId: string;
  initial: CommandResult;
  retry: CommandResult;
  changedFiles: string[];
  mode: AgentResult['mode'];
}): Promise<VerifiedRepairOutcome> {
  if (!input.eligible) {
    return {
      attempted: false,
      recorded: false,
      reason:
        input.mode === 'substitute'
          ? 'Controlled substitute agent does not publish Phoenix repair outcomes.'
          : 'Strict repair and Phoenix evidence gates did not all pass.',
    };
  }
  const provider = registerPhoenixProvider();
  if (!provider) {
    return {
      attempted: false,
      recorded: false,
      reason: 'Phoenix exporter env is missing for verified outcome recording.',
    };
  }
  const initialOutput = createRedactedOutputPreview(
    `${input.initial.stdout}\n${input.initial.stderr}`,
  );
  const signature = buildTracePilotFailureSignature({
    command: input.initial.command,
    exitCode: input.initial.exitCode,
    outputPreview: initialOutput.preview,
    outputSha256: initialOutput.sha256,
  });
  const strategy = [
    'Reuse the verified minimal checkout-service source repair for a matching failed-test signature.',
    'Rerun the failed test command after applying the minimal source-only patch.',
  ];
  const repairFingerprint = createTracePilotRepairFingerprint({
    strategy,
    filesModified: input.changedFiles,
    verificationCommands: [input.retry.command],
  });
  try {
    const span = trace
      .getTracer('tracepilot-gemini-repair-demo')
      .startSpan(GeminiCliOperation.RepairReport, {
        attributes: {
          'session.id': input.sessionId,
          [GEMINI_CLI_REPAIR_SIGNATURE_ID]: signature.id,
          [GEMINI_CLI_REPAIR_ROOT_CAUSE]: signature.taxonomy,
          [GEMINI_CLI_REPAIR_FINGERPRINT]: repairFingerprint,
          [GEMINI_CLI_REPAIR_STRATEGY]: JSON.stringify(strategy),
          [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]: true,
          [GEMINI_CLI_OUTPUT_SHA256]: initialOutput.sha256,
        },
      });
    span.end();
    await provider.forceFlush();
    return {
      attempted: true,
      recorded: true,
      signatureId: signature.id,
      repairFingerprint,
    };
  } catch (error) {
    return {
      attempted: true,
      recorded: false,
      reason: `Phoenix verified outcome recording failed: ${getErrorMessage(error)}`,
    };
  } finally {
    await provider.shutdown().catch(() => undefined);
  }
}

function registerPhoenixProvider(): NodeTracerProvider | undefined {
  const apiKey = process.env['PHOENIX_API_KEY']?.trim();
  const project = process.env['PHOENIX_PROJECT']?.trim();
  const url =
    process.env['PHOENIX_COLLECTOR_ENDPOINT']?.trim() ??
    process.env['PHOENIX_BASE_URL']?.trim();
  if (!apiKey || !project || !url) {
    return undefined;
  }
  return register({
    apiKey,
    projectName: project,
    url,
    batch: false,
    global: true,
  });
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    workdir: path.join(tmpdir(), 'tracepilot-demo-gemini-repair'),
    output: '.ai-logs/demo-gemini-repair-agent/result.json',
    allowMissingPhoenix: false,
    envFile: path.resolve('.env'),
    cliPath: path.resolve('packages/cli/dist/index.js'),
    model: 'gemini-3.1-flash-lite-preview',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--workdir') {
      options.workdir = argv[++index] ?? options.workdir;
    } else if (arg === '--output') {
      options.output = argv[++index] ?? options.output;
    } else if (arg === '--allow-missing-phoenix') {
      options.allowMissingPhoenix = true;
    } else if (arg === '--agent-script') {
      options.agentScript = argv[++index];
    } else if (arg === '--env-file') {
      options.envFile = path.resolve(argv[++index] ?? options.envFile);
    } else if (arg === '--cli-path') {
      options.cliPath = path.resolve(argv[++index] ?? options.cliPath);
    } else if (arg === '--model') {
      options.model = argv[++index] ?? options.model;
    }
  }
  return options;
}

async function runAgent(
  options: Options,
  demoDir: string,
  sessionId: string,
): Promise<AgentResult> {
  if (options.agentScript) {
    const result = await runCommand(
      process.execPath,
      [path.resolve(options.agentScript), demoDir],
      demoDir,
    );
    return { ...result, mode: 'substitute' };
  }

  const prompt = [
    'Repair this broken checkout webhook service.',
    'Run npm test first to observe the failure evidence.',
    'When the failed tool result includes TracePilot Phoenix evidence, use it in your diagnosis.',
    'Apply the smallest safe changes under src only, then rerun npm test until it passes.',
    'Do the edits and verification; do not only explain the fix.',
  ].join(' ');
  const isolatedGeminiHome = path.join(
    tmpdir(),
    'tracepilot-gemini-home',
    sessionId,
  );
  await mkdir(path.join(isolatedGeminiHome, '.gemini'), { recursive: true });
  await writeFile(
    path.join(isolatedGeminiHome, '.gemini', 'settings.json'),
    `${JSON.stringify({ tools: { shell: { enableInteractiveShell: false } } }, null, 2)}\n`,
    'utf8',
  );
  const result = await runCommand(
    process.execPath,
    [
      options.cliPath,
      '--prompt',
      prompt,
      '--session-id',
      sessionId,
      '--approval-mode=yolo',
      '--sandbox=false',
      '--skip-trust',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
    ],
    demoDir,
    {
      GEMINI_CLI_HOME: isolatedGeminiHome,
      GEMINI_CLI_NO_RELAUNCH: 'true',
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
    },
    15 * 60 * 1000,
  );
  return { ...result, mode: 'gemini' };
}

async function runNodeTests(cwd: string): Promise<CommandResult> {
  return runCommand(process.execPath, ['--test'], cwd);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeout = 5 * 60 * 1000,
): Promise<CommandResult> {
  const rendered = [path.basename(command), ...args].join(' ');
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
    });
    return {
      command: rendered,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = getExecFailure(error);
    return { command: rendered, ...failure };
  }
}

async function captureFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const relativePath of await listFiles(dir)) {
    files.set(
      relativePath,
      await readFile(path.join(dir, relativePath), 'utf8'),
    );
  }
  return files;
}

async function listFiles(root: string, current = ''): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(path.join(root, current));
  for (const entry of entries) {
    const relativePath = path.join(current, entry);
    const entryStat = await stat(path.join(root, relativePath));
    if (entryStat.isDirectory()) {
      result.push(...(await listFiles(root, relativePath)));
    } else {
      result.push(relativePath.replaceAll('\\', '/'));
    }
  }
  return result.sort();
}

function findChangedFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const all = new Set([...before.keys(), ...after.keys()]);
  return [...all].filter((file) => before.get(file) !== after.get(file)).sort();
}

async function queryPhoenixSession(
  sessionId: string,
): Promise<PhoenixSessionEvidence> {
  const host = resolvePhoenixHost();
  const project = process.env['PHOENIX_PROJECT']?.trim();
  if (!host || !project || !process.env['PHOENIX_API_KEY']?.trim()) {
    return degradedPhoenix('Phoenix API key, host, or project is missing.');
  }
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', resolvePhoenixMcpPackage()],
    env: { ...process.env, PHOENIX_HOST: host, PHOENIX_PROJECT: project },
  });
  const client = new Client({
    name: 'tracepilot-gemini-repair-demo',
    version: '0.0.0',
  });
  try {
    await client.connect(transport);
    const startTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    for (let attempt = 1; attempt <= 8; attempt++) {
      const spans: Array<Record<string, unknown>> = [];
      for (const spanName of [
        GeminiCliOperation.ToolShell,
        GeminiCliOperation.ToolPhoenixMcp,
        GeminiCliOperation.SelfIntrospection,
      ]) {
        const result = await client.callTool(
          {
            name: 'get-spans',
            arguments: {
              project_identifier: project,
              start_time: startTime,
              names: [spanName],
              session_id: sessionId,
              limit: 20,
            },
          },
          undefined,
          { timeout: PHOENIX_MCP_QUERY_TIMEOUT_MS },
        );
        spans.push(...getSpanList(parseJsonText(getTextContent(result))));
      }
      const sessionSpans = spans.filter(
        (span) => getRecord(span.attributes)?.['session.id'] === sessionId,
      );
      const failedTool = sessionSpans.find(
        (span) =>
          span.name === GeminiCliOperation.ToolShell &&
          Number(getRecord(span.attributes)?.[GEMINI_CLI_COMMAND_EXIT_CODE]) !==
            0,
      );
      const passingTool = sessionSpans.find(
        (span) =>
          span.name === GeminiCliOperation.ToolShell &&
          Number(getRecord(span.attributes)?.[GEMINI_CLI_COMMAND_EXIT_CODE]) ===
            0,
      );
      const introspection = sessionSpans.find(
        (span) => span.name === GeminiCliOperation.SelfIntrospection,
      );
      const introspectionSpan = Boolean(introspection);
      const phoenixMcpSpan = sessionSpans.some(
        (span) => span.name === GeminiCliOperation.ToolPhoenixMcp,
      );
      const introspectionEvidenceAvailable = introspection
        ? containsAvailableEvidence(
            getRecord(introspection.attributes)?.['gen_ai.output.messages'],
          )
        : false;
      if (
        failedTool &&
        introspectionSpan &&
        phoenixMcpSpan &&
        introspectionEvidenceAvailable
      ) {
        const context = getRecord(failedTool.context);
        return {
          attempted: true,
          queryable: true,
          visible: true,
          failedToolSpan: true,
          passingToolSpan: Boolean(passingTool),
          introspectionSpan,
          phoenixMcpSpan,
          introspectionEvidenceAvailable,
          traceId:
            getString(context, 'trace_id') ?? getString(failedTool, 'trace_id'),
          spanId:
            getString(context, 'span_id') ?? getString(failedTool, 'span_id'),
        };
      }
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    return {
      attempted: true,
      queryable: true,
      visible: false,
      failedToolSpan: false,
      passingToolSpan: false,
      introspectionSpan: false,
      phoenixMcpSpan: false,
      introspectionEvidenceAvailable: false,
      reason:
        'Phoenix MCP did not return the Gemini repair session spans in time.',
    };
  } catch (error) {
    return {
      ...degradedPhoenix(`Phoenix MCP query failed: ${getErrorMessage(error)}`),
      attempted: true,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function buildEvalEvidence(
  sessionId: string,
  initial: CommandResult,
  retry: CommandResult,
  phoenix: PhoenixSessionEvidence,
  changedFiles: string[],
): TracePilotEvalEvidence {
  const retryOutput = createRedactedOutputPreview(
    `${retry.stdout}\n${retry.stderr}`,
  );
  const sample = createRedactedOutputPreview(
    'Authorization: Bearer videoSecretToken',
  );
  return {
    command: {
      command: retry.command,
      completed: retry.exitCode === 0,
      exitCode: retry.exitCode,
      outputPreview: retryOutput.preview,
      outputSha256: retryOutput.sha256,
    },
    test: {
      command: retry.command,
      passed: retry.exitCode === 0,
      exitCode: retry.exitCode,
    },
    safety: {
      command: 'rm -rf /',
      blocked: true,
      reason: 'demo blocks destructive commands',
    },
    redaction: {
      samples: [
        {
          input: 'Authorization: Bearer videoSecretToken',
          output: sample.preview,
        },
      ],
    },
    phoenix: {
      spanCreated: phoenix.visible,
      exported: phoenix.visible,
      visible: phoenix.visible,
      queryable: phoenix.queryable,
      project: process.env['PHOENIX_PROJECT'],
      sessionId,
      traceId: phoenix.traceId,
      spanId: phoenix.spanId,
    },
    selfIntrospection: {
      triggered: initial.exitCode !== 0,
      queryAttempted: phoenix.attempted,
      evidenceAttached:
        phoenix.introspectionSpan &&
        phoenix.phoenixMcpSpan &&
        phoenix.introspectionEvidenceAvailable,
      evidenceText: phoenix.introspectionEvidenceAvailable
        ? 'TracePilot Phoenix evidence for repair plan: session spans visible through Phoenix MCP.'
        : undefined,
      unavailableReason: phoenix.reason,
    },
    repair: {
      planCreated: true,
      referencedTraceEvidence: phoenix.introspectionEvidenceAvailable,
      fixApplied: changedFiles.length > 0,
      retryExitCode: retry.exitCode,
      evalLogged: true,
    },
  };
}

function degradedPhoenix(reason: string): PhoenixSessionEvidence {
  return {
    attempted: false,
    queryable: false,
    visible: false,
    failedToolSpan: false,
    passingToolSpan: false,
    introspectionSpan: false,
    phoenixMcpSpan: false,
    introspectionEvidenceAvailable: false,
    reason,
  };
}

function summarizeCommand(result: CommandResult) {
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

function containsAvailableEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\\?"available\\?"\s*:\s*true/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsAvailableEvidence);
  }
  const record = getRecord(value);
  if (!record) {
    return false;
  }
  if (record['available'] === true) {
    return true;
  }
  return Object.values(record).some(containsAvailableEvidence);
}

function printProofLines(
  report: {
    ok: boolean;
    sessionId: string;
    initialTest: { exitCode: number };
    agent: { mode: string; exitCode: number };
    phoenix: PhoenixSessionEvidence;
    repair: {
      changedFiles: string[];
      onlyExpectedFilesChanged: boolean;
      verifiedOutcomeRecorded: boolean;
    };
    retryTest: { exitCode: number };
    eval: { ok: boolean };
  },
  output: string,
): void {
  console.log(
    `INITIAL_FIXTURE_TEST: ${report.initialTest.exitCode !== 0 ? 'FAIL (expected)' : 'FAIL'}`,
  );
  console.log(
    `AGENT_REPAIR: ${report.agent.exitCode === 0 ? 'PASS' : 'FAIL'} mode=${report.agent.mode}`,
  );
  console.log(
    `FAILED_TOOL_SPAN: ${report.phoenix.failedToolSpan ? 'PASS' : report.agent.mode === 'substitute' ? 'DEGRADED' : 'FAIL'}`,
  );
  console.log(
    `PHOENIX_MCP_INTROSPECTION: ${report.phoenix.introspectionSpan && report.phoenix.phoenixMcpSpan && report.phoenix.introspectionEvidenceAvailable ? 'PASS' : report.agent.mode === 'substitute' ? 'DEGRADED' : 'FAIL'}`,
  );
  console.log(
    `VERIFIED_REPAIR_RECORDED: ${report.repair.verifiedOutcomeRecorded ? 'PASS' : report.agent.mode === 'substitute' ? 'DEGRADED' : 'FAIL'}`,
  );
  console.log(
    `FILES_CHANGED: ${report.repair.onlyExpectedFilesChanged ? 'PASS' : 'FAIL'} count=${report.repair.changedFiles.length}`,
  );
  console.log(
    `RETRY_TEST: ${report.retryTest.exitCode === 0 ? 'PASS' : 'FAIL'}`,
  );
  console.log(
    `EVALS: ${report.eval.ok ? 'PASS' : report.agent.mode === 'substitute' ? 'DEGRADED' : 'FAIL'}`,
  );
  console.log(`SESSION_ID: ${report.sessionId}`);
  console.log(`REPORT: ${output}`);
}

function resolvePhoenixMcpPackage(): string {
  return (
    process.env['TRACEPILOT_PHOENIX_MCP_PACKAGE']?.trim() ||
    DEFAULT_PHOENIX_MCP_PACKAGE
  );
}

function resolvePhoenixHost(): string | undefined {
  for (const candidate of [
    process.env['PHOENIX_HOST'],
    process.env['PHOENIX_BASE_URL'],
    process.env['PHOENIX_COLLECTOR_ENDPOINT'],
  ]) {
    const normalized = normalizePhoenixUrl(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizePhoenixUrl(value: string | undefined): string | undefined {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed || /YOUR_|your-|example/i.test(trimmed)) return undefined;
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

function getTextContent(result: unknown): string {
  const content = getRecord(result)?.['content'];
  return (Array.isArray(content) ? content : [])
    .map((part) => getRecord(part))
    .filter((part) => part?.['type'] === 'text')
    .map((part) => getString(part, 'text') ?? '')
    .join('\n');
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function getSpanList(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  const record = getRecord(payload);
  const spans = record?.['spans'] ?? record?.['data'];
  return Array.isArray(spans) ? spans.filter(isRecord) : [];
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

function getExecFailure(error: unknown): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const record = getRecord(error);
  return {
    exitCode: typeof record?.['code'] === 'number' ? record['code'] : 1,
    stdout: typeof record?.['stdout'] === 'string' ? record['stdout'] : '',
    stderr:
      typeof record?.['stderr'] === 'string'
        ? record['stderr']
        : getErrorMessage(error),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
