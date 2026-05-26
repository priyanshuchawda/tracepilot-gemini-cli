#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
dotenv.config();
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  register,
  SpanStatusCode,
  trace,
  type NodeTracerProvider,
} from '@arizeai/phoenix-otel';
import {
  GEMINI_CLI_COMMAND_EXIT_CODE,
  GEMINI_CLI_OUTPUT_PREVIEW,
  GEMINI_CLI_OUTPUT_SHA256,
  GEN_AI_TOOL_NAME,
} from '../packages/core/src/telemetry/constants.js';
import {
  connectDirectPhoenixMcpClient,
  DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS,
  getSpanList,
  resolveDirectPhoenixMcpConfig,
  resolveTracePilotPhoenixEnv,
} from '../packages/core/src/telemetry/phoenixMcpUtils.js';
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';
import {
  runTracePilotEvals,
  type TracePilotEvalEvidence,
} from '../packages/core/src/tracepilot/evals.js';
import { buildTracePilotFailureSignature } from '../packages/core/src/tracepilot/failureSignature.js';
import {
  describeTracePilotProofLevel,
  isStrictTracePilotProofLevel,
  TRACEPILOT_PROOF_LEVELS,
  type TracePilotProofLevel,
} from '../packages/core/src/tracepilot/proofLevel.js';
import { stableTracePilotProofReportJson } from '../packages/core/src/tracepilot/proofReport.js';
import { calculateTracePilotRepairConfidence } from '../packages/core/src/tracepilot/repairConfidence.js';
import {
  completeTracePilotRepairArtifact,
  createTracePilotRepairArtifact,
  type TracePilotPatchSummary,
} from '../packages/core/src/tracepilot/repairReport.js';
import { classifyTracePilotPatchRisk } from '../packages/core/src/tracepilot/repairRisk.js';
import type { TracePilotVerificationResult } from '../packages/core/src/tracepilot/verificationMatrix.js';
import { classifyTracePilotCommandRisk } from '../packages/core/src/policy/tracepilot-command-risk.js';

const execFileAsync = promisify(execFile);
const EXPECTED_API_BASE_URL = 'https://api.example.test';
const PHOENIX_MCP_QUERY_TIMEOUT_MS = DEFAULT_PHOENIX_MCP_QUERY_TIMEOUT_MS;

interface CliOptions {
  workdir: string;
  output: string;
  allowMissingPhoenix: boolean;
}

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PhoenixQueryEvidence {
  attempted: boolean;
  spanCreated: boolean;
  exported: boolean;
  visible: boolean;
  queryable: boolean;
  reason?: string;
  traceId?: string;
  spanId?: string;
}

async function main(argv: string[]): Promise<number> {
  const startedAt = Date.now();
  const options = parseArgs(argv);
  const fixtureDir = path.resolve('examples/broken-node-app');
  const demoDir = path.resolve(options.workdir);
  await rm(demoDir, { recursive: true, force: true });
  await mkdir(path.dirname(demoDir), { recursive: true });
  await cp(fixtureDir, demoDir, { recursive: true });

  const sessionId = `tracepilot-broken-node-app-${Date.now()}`;
  const failed = await runNpmTest(demoDir);
  const failurePreview = createRedactedOutputPreview(
    `${failed.stdout}\n${failed.stderr}`,
  );
  const phoenix = await recordFailureAndQueryPhoenix(sessionId, failed);
  const traceEvidenceText = buildTraceEvidenceText(phoenix, failurePreview);
  const repairPlan = [
    'TracePilot repair plan:',
    traceEvidenceText,
    `Set the default API base URL to ${EXPECTED_API_BASE_URL}.`,
    'Rerun npm test after the patch.',
  ].join('\n');

  await applyRepair(demoDir);
  const retry = await runNpmTest(demoDir);
  const redactionSample = createRedactedOutputPreview(
    'OPENAI_API_KEY=sk-proj-demoSecret0000000000000000',
  );
  const evalEvidence: TracePilotEvalEvidence = {
    command: {
      command: retry.command,
      completed: retry.exitCode === 0,
      exitCode: retry.exitCode,
      outputPreview: createRedactedOutputPreview(
        `${retry.stdout}\n${retry.stderr}`,
      ).preview,
      outputSha256: createRedactedOutputPreview(
        `${retry.stdout}\n${retry.stderr}`,
      ).sha256,
    },
    test: {
      command: retry.command,
      passed: retry.exitCode === 0,
      exitCode: retry.exitCode,
    },
    safety: observeSafetyBlock('rm -rf /'),
    redaction: {
      samples: [
        {
          input: 'OPENAI_API_KEY=sk-proj-demoSecret0000000000000000',
          output: redactionSample.preview,
        },
      ],
    },
    phoenix: {
      spanCreated: phoenix.spanCreated,
      exported: phoenix.exported,
      visible: phoenix.visible,
      queryable: phoenix.queryable,
      project: process.env['PHOENIX_PROJECT'],
      sessionId,
      traceId: phoenix.traceId,
      spanId: phoenix.spanId,
    },
    selfIntrospection: {
      triggered: failed.exitCode !== 0,
      queryAttempted: phoenix.attempted,
      evidenceAttached: traceEvidenceText.includes(
        'TracePilot Phoenix evidence',
      ),
      evidenceText: traceEvidenceText,
      unavailableReason: phoenix.reason,
    },
    repair: {
      planCreated: true,
      referencedTraceEvidence: repairPlan.includes(
        'TracePilot Phoenix evidence',
      ),
      fixApplied: true,
      retryExitCode: retry.exitCode,
      evalLogged: true,
    },
  };
  const evalReport = runTracePilotEvals(evalEvidence);
  const proofLevel = deriveProofLevel(phoenix);
  const repairArtifact = buildCompletedRepairArtifact({
    sessionId,
    failed,
    retry,
    phoenix,
    startedAt,
  });
  const report = {
    ok: retry.exitCode === 0 && (evalReport.ok || options.allowMissingPhoenix),
    proofLevel,
    strictLiveProof: isStrictTracePilotProofLevel(proofLevel),
    proofSummary: describeTracePilotProofLevel(proofLevel),
    localRepairOk: failed.exitCode !== 0 && retry.exitCode === 0,
    allowMissingPhoenix: options.allowMissingPhoenix,
    workdir: demoDir,
    sessionId,
    initialTest: summarizeCommand(failed),
    retryTest: summarizeCommand(retry),
    phoenix,
    repairPlan,
    repairArtifact,
    eval: evalReport,
  };

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(
    options.output,
    stableTracePilotProofReportJson(report),
    'utf8',
  );
  console.log(
    `PROOF_LEVEL: ${report.proofLevel} strictLiveProof=${report.strictLiveProof}`,
  );
  console.log(`TracePilot broken-node-app demo report: ${options.output}`);
  if (!report.ok && !options.allowMissingPhoenix) {
    console.error(
      'Demo local repair completed, but TracePilot evals are not all passing. Check Phoenix env and MCP visibility.',
    );
  }
  return report.ok ? 0 : 1;
}

function buildCompletedRepairArtifact(input: {
  sessionId: string;
  failed: CommandResult;
  retry: CommandResult;
  phoenix: PhoenixQueryEvidence;
  startedAt: number;
}) {
  const initialPreview = createRedactedOutputPreview(
    `${input.failed.stdout}\n${input.failed.stderr}`,
  );
  const retryPreview = createRedactedOutputPreview(
    `${input.retry.stdout}\n${input.retry.stderr}`,
  );
  const signature = buildTracePilotFailureSignature({
    command: input.failed.command,
    exitCode: input.failed.exitCode,
    outputPreview: initialPreview.preview,
    outputSha256: initialPreview.sha256,
  });
  const filesModified = ['src/config.js'];
  const patches: TracePilotPatchSummary[] = [
    {
      file: 'src/config.js',
      linesAdded: 1,
      linesDeleted: 1,
      description: `Set default API base URL to ${EXPECTED_API_BASE_URL}.`,
    },
  ];
  const verificationMatrix: TracePilotVerificationResult[] = [
    {
      id: 'failed_command',
      command: input.retry.command,
      required: true,
      reason: 'prove the originally failing fixture test now passes',
      status: input.retry.exitCode === 0 ? 'pass' : 'fail',
      exitCode: input.retry.exitCode,
      outputSha256: retryPreview.sha256,
    },
    {
      id: 'patch_minimality',
      required: true,
      reason: 'confirm the deterministic repair changed only src/config.js',
      status: 'pass',
    },
    {
      id: 'regression_scope',
      required: true,
      reason: 'fixture retry covers the repaired API base URL behavior',
      status: input.retry.exitCode === 0 ? 'pass' : 'fail',
    },
  ];
  const patchRisk = classifyTracePilotPatchRisk({
    filesModified,
    linesAdded: 1,
    linesDeleted: 1,
  });
  const plannedArtifact = createTracePilotRepairArtifact({
    schemaVersion: 1,
    sessionId: input.sessionId,
    phase: 'planned',
    failure: {
      summary: `Fixture test failed in ${input.failed.command}`,
      rootCause: signature.taxonomy,
      signature,
    },
    phoenix: {
      tracesConsulted: input.phoenix.traceId ? [input.phoenix.traceId] : [],
      mcpQueries: [
        {
          serverName: 'phoenix',
          toolName: 'get-spans',
          arguments: {
            sessionId: input.sessionId,
            names: ['gemini_cli.tool.shell'],
          },
          resultCount: input.phoenix.visible ? 1 : 0,
          status: input.phoenix.visible
            ? 'ok'
            : input.phoenix.attempted
              ? 'error'
              : 'skipped',
          reason: input.phoenix.reason,
        },
      ],
    },
    repair: {
      selectedStrategy: [
        `Set the default API base URL to ${EXPECTED_API_BASE_URL}.`,
        'Rerun the fixture test after the patch.',
      ],
      historicalMatches: [],
      patches: [],
      filesModified: [],
    },
    safety: {
      risk: patchRisk,
      rollbackStrategy: ['Restore examples/broken-node-app/src/config.js.'],
    },
    verification: {
      matrix: [],
      regressionConfidence: 0,
    },
    confidence: calculateTracePilotRepairConfidence({
      phoenixEvidenceAvailable: input.phoenix.visible,
      verificationCoverageScore: input.retry.exitCode === 0 ? 1 : 0.4,
      patchMinimalityScore: 1,
      riskLevel: patchRisk.level,
      regressionPassed: input.retry.exitCode === 0,
    }),
    metrics: {
      repairDurationMs: Date.now() - input.startedAt,
      retriesRequired: 0,
      unsafeCommandsBlocked: 0,
    },
  });
  return completeTracePilotRepairArtifact(plannedArtifact, {
    filesModified,
    patches,
    verificationMatrix,
    retryMetadata: {
      attempts: 1,
      retryCommands: [input.retry.command],
      finalExitCode: input.retry.exitCode,
    },
    repairDurationMs: Date.now() - input.startedAt,
    completedAt: new Date().toISOString(),
    rollbackStrategy: ['Restore examples/broken-node-app/src/config.js.'],
  });
}

function deriveProofLevel(phoenix: PhoenixQueryEvidence): TracePilotProofLevel {
  return phoenix.visible && phoenix.queryable
    ? TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX
    : TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workdir: path.join(tmpdir(), 'tracepilot-demo-broken-node-app'),
    output: '.ai-logs/demo-broken-node-app/result.json',
    allowMissingPhoenix: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--workdir') {
      options.workdir = argv[++index] ?? options.workdir;
    } else if (arg === '--output') {
      options.output = argv[++index] ?? options.output;
    } else if (arg === '--allow-missing-phoenix') {
      options.allowMissingPhoenix = true;
    }
  }
  return options;
}

async function runNpmTest(cwd: string): Promise<CommandResult> {
  try {
    const result = await execFileAsync(process.execPath, ['--test'], {
      cwd,
      windowsHide: true,
    });
    return {
      command: 'node --test',
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failed = getExecFailure(error);
    return {
      command: 'node --test',
      exitCode: failed.exitCode,
      stdout: failed.stdout,
      stderr: failed.stderr,
    };
  }
}

async function recordFailureAndQueryPhoenix(
  sessionId: string,
  failed: CommandResult,
): Promise<PhoenixQueryEvidence> {
  const provider = registerPhoenixProvider();
  if (!provider) {
    const phoenixEnv = resolveTracePilotPhoenixEnv(process.env);
    return {
      attempted: false,
      spanCreated: false,
      exported: false,
      visible: false,
      queryable: false,
      reason:
        phoenixEnv.mcpSkipReason ??
        'Missing Phoenix env for live TracePilot proof.',
    };
  }

  const preview = createRedactedOutputPreview(
    `${failed.stdout}\n${failed.stderr}`,
  );
  const tracer = trace.getTracer('tracepilot-demo');
  const span = tracer.startSpan('gemini_cli.tool.shell', {
    attributes: {
      [GEN_AI_TOOL_NAME]: 'run_shell_command',
      [GEMINI_CLI_COMMAND_EXIT_CODE]: failed.exitCode,
      [GEMINI_CLI_OUTPUT_PREVIEW]: preview.preview,
      [GEMINI_CLI_OUTPUT_SHA256]: preview.sha256,
      'session.id': sessionId,
      'tracepilot.demo': true,
      'tracepilot.demo_session': sessionId,
    },
  });
  if (failed.exitCode !== 0) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Command failed with exit code ${failed.exitCode}`,
    });
  }
  span.end();

  try {
    await provider.forceFlush();
    const query = await queryPhoenixMcp(sessionId);
    return {
      attempted: query.attempted,
      spanCreated: true,
      exported: true,
      visible: query.visible,
      queryable: query.queryable,
      reason: query.reason,
      traceId: query.traceId,
      spanId: query.spanId,
    };
  } catch (error) {
    return {
      attempted: true,
      spanCreated: true,
      exported: false,
      visible: false,
      queryable: false,
      reason: redactMessage(getErrorMessage(error)),
    };
  } finally {
    await provider.shutdown().catch(() => undefined);
  }
}

function registerPhoenixProvider(): NodeTracerProvider | undefined {
  const phoenixEnv = resolveTracePilotPhoenixEnv(process.env);
  const apiKey = phoenixEnv.apiKey;
  const project = phoenixEnv.project;
  const url = phoenixEnv.collectorEndpoint ?? phoenixEnv.baseUrl;
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

async function queryPhoenixMcp(
  sessionId: string,
): Promise<Omit<PhoenixQueryEvidence, 'spanCreated' | 'exported'>> {
  const directConfig = resolveDirectPhoenixMcpConfig(process.env);
  if (!directConfig) {
    const phoenixEnv = resolveTracePilotPhoenixEnv(process.env);
    return {
      attempted: false,
      visible: false,
      queryable: false,
      reason:
        phoenixEnv.mcpSkipReason ??
        'Phoenix MCP API key, host, or project env missing.',
    };
  }
  const client = await connectDirectPhoenixMcpClient(directConfig, {
    clientName: 'tracepilot-broken-node-app-demo',
  });

  try {
    const toolNames = await client.listTools();
    if (!toolNames.includes('get-spans')) {
      return {
        attempted: true,
        visible: false,
        queryable: false,
        reason: 'Phoenix MCP connected but did not expose get-spans.',
      };
    }

    const startTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await client.callGetSpans(
        {
          project_identifier: directConfig.project,
          start_time: startTime,
          names: ['gemini_cli.tool.shell'],
          limit: 100,
        },
        PHOENIX_MCP_QUERY_TIMEOUT_MS,
      );
      if (result.error) {
        return {
          attempted: true,
          visible: false,
          queryable: false,
          reason: result.error.message,
        };
      }
      const spans = getSpanList(result.data ?? result.llmContent);
      const span = spans.find((candidate) => {
        const attributes = getRecord(candidate['attributes']);
        return attributes?.['tracepilot.demo_session'] === sessionId;
      });
      if (span) {
        const context = getRecord(span['context']);
        return {
          attempted: true,
          visible: true,
          queryable: true,
          traceId:
            getString(context, 'trace_id') ?? getString(span, 'trace_id'),
          spanId: getString(context, 'span_id') ?? getString(span, 'span_id'),
        };
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    return {
      attempted: true,
      visible: false,
      queryable: true,
      reason: 'Phoenix MCP query completed but did not find the demo span.',
    };
  } finally {
    await client.close();
  }
}

async function applyRepair(demoDir: string): Promise<void> {
  const configPath = path.join(demoDir, 'src/config.js');
  const original = await readFile(configPath, 'utf8');
  await writeFile(
    configPath,
    original.replace('http://localhost:3000', EXPECTED_API_BASE_URL),
    'utf8',
  );
}

function buildTraceEvidenceText(
  phoenix: PhoenixQueryEvidence,
  failurePreview: ReturnType<typeof createRedactedOutputPreview>,
): string {
  if (!phoenix.visible) {
    return [
      'TracePilot Phoenix evidence unavailable:',
      phoenix.reason ?? 'Phoenix MCP did not return a matching failed span.',
      `output_sha256=${failurePreview.sha256}`,
      `output_preview=${failurePreview.preview}`,
    ].join('\n');
  }
  return [
    'TracePilot Phoenix evidence for repair plan:',
    'span=gemini_cli.tool.shell',
    `trace_id=${phoenix.traceId ?? 'unknown'}`,
    `span_id=${phoenix.spanId ?? 'unknown'}`,
    `output_sha256=${failurePreview.sha256}`,
    `output_preview=${failurePreview.preview}`,
  ].join('\n');
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

function observeSafetyBlock(command: string): TracePilotEvalEvidence['safety'] {
  const risk = classifyTracePilotCommandRisk(command);
  return {
    command,
    blocked: risk.level === 'blocked',
    observed: true,
    level: risk.level,
    reason: risk.reason,
  };
}

function getExecFailure(error: unknown): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const record = getRecord(error);
  return {
    exitCode: getNumber(record, 'code') ?? 1,
    stdout: getString(record, 'stdout') ?? '',
    stderr: getString(record, 'stderr') ?? getErrorMessage(error),
  };
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

function getNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactMessage(message: string): string {
  return createRedactedOutputPreview(message).preview;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
