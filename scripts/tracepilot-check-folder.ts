#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
dotenv.config();
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  GEMINI_CLI_REPAIR_CONFIDENCE_SCORE,
  GEMINI_CLI_REPAIR_REGRESSION_CONFIDENCE,
  GEMINI_CLI_REPAIR_RISK_LEVEL,
  GEMINI_CLI_REPAIR_ROOT_CAUSE,
  GEMINI_CLI_REPAIR_SIGNATURE_ID,
  GEMINI_CLI_REPAIR_VERIFICATION_PASSED,
  GEN_AI_TOOL_NAME,
} from '../packages/core/src/telemetry/constants.js';
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';
import { buildTracePilotFailureSignature } from '../packages/core/src/tracepilot/failureSignature.js';
import { calculateTracePilotRepairConfidence } from '../packages/core/src/tracepilot/repairConfidence.js';
import {
  createTracePilotRepairArtifact,
  renderTracePilotRepairMarkdown,
  stableTracePilotRepairArtifactJson,
  type TracePilotPatchSummary,
} from '../packages/core/src/tracepilot/repairReport.js';
import { classifyTracePilotPatchRisk } from '../packages/core/src/tracepilot/repairRisk.js';
import {
  calculateTracePilotRegressionConfidence,
  type TracePilotVerificationResult,
} from '../packages/core/src/tracepilot/verificationMatrix.js';

const execFileAsync = promisify(execFile);

interface CliOptions {
  workdir: string;
  outputDir: string;
}

interface CommandSpec {
  id: TracePilotVerificationResult['id'];
  executable: string;
  args: string[];
  reason: string;
  required: boolean;
}

interface CommandRun {
  spec: CommandSpec;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const workdir = path.resolve(options.workdir);
  const outputDir = path.resolve(workdir, options.outputDir);
  const sessionId = `tracepilot-check-${Date.now()}`;
  const provider = registerPhoenixProvider();
  const startedAt = Date.now();
  const specs = await buildCommandSpecs(workdir);
  const runs: CommandRun[] = [];

  try {
    for (const spec of specs) {
      const run = await runCommand(workdir, spec);
      runs.push(run);
      recordCommandSpan(sessionId, run);
    }

    const firstFailure = runs.find((run) => run.exitCode !== 0);
    const failurePreview = createRedactedOutputPreview(
      firstFailure
        ? `${firstFailure.stdout}\n${firstFailure.stderr}`
        : 'TracePilot verification matrix passed.',
    );
    const signature = buildTracePilotFailureSignature({
      command: firstFailure
        ? formatCommand(firstFailure.spec)
        : 'tracepilot verification matrix',
      exitCode: firstFailure?.exitCode ?? 0,
      outputPreview: failurePreview.preview,
      outputSha256: failurePreview.sha256,
      dependencies: await readPackageVersions(workdir),
    });
    const verificationMatrix: TracePilotVerificationResult[] = runs.map(
      (run) => {
        const preview = createRedactedOutputPreview(
          `${run.stdout}\n${run.stderr}`,
        );
        return {
          id: run.spec.id,
          command: formatCommand(run.spec),
          required: run.spec.required,
          reason: run.spec.reason,
          status: run.exitCode === 0 ? 'pass' : 'fail',
          exitCode: run.exitCode,
          outputSha256: preview.sha256,
        };
      },
    );
    const regressionConfidence =
      calculateTracePilotRegressionConfidence(verificationMatrix);
    const patchRisk = classifyTracePilotPatchRisk({
      filesModified: [],
    });
    const confidence = calculateTracePilotRepairConfidence({
      phoenixEvidenceAvailable: provider !== undefined,
      verificationCoverageScore: verificationMatrix.length > 0 ? 1 : 0,
      patchMinimalityScore: 1,
      riskLevel: patchRisk.level,
      regressionPassed: regressionConfidence === 1,
    });
    const patches: TracePilotPatchSummary[] = [];
    const artifact = createTracePilotRepairArtifact({
      schemaVersion: 1,
      sessionId,
      failure: {
        summary: firstFailure
          ? `Verification failed in ${formatCommand(firstFailure.spec)}`
          : 'Verification matrix passed without repair.',
        rootCause: signature.taxonomy,
        signature,
      },
      phoenix: {
        tracesConsulted: [],
        mcpQueries: [
          {
            serverName: 'phoenix',
            toolName: 'get-spans',
            arguments: {
              mode: 'local-verification-artifact',
              sessionId,
              signatureId: signature.id,
            },
            resultCount: 0,
            status: provider ? 'ok' : 'skipped',
            reason: provider
              ? undefined
              : 'Phoenix env not configured; local deterministic artifact generated.',
          },
        ],
      },
      repair: {
        selectedStrategy: firstFailure
          ? [
              'Inspect the failing command output.',
              'Apply a minimal patch tied to the failure signature.',
              'Rerun the full TracePilot verification matrix.',
            ]
          : ['No repair required; persist successful verification evidence.'],
        historicalMatches: [],
        patches,
        filesModified: [],
      },
      safety: {
        risk: patchRisk,
        rollbackStrategy: ['No patch applied by tracepilot-check-folder.'],
      },
      verification: {
        matrix: verificationMatrix,
        regressionConfidence,
      },
      confidence,
      metrics: {
        repairDurationMs: Date.now() - startedAt,
        retriesRequired: 0,
        unsafeCommandsBlocked: 0,
      },
    });

    recordRepairArtifactSpan(sessionId, artifact);
    await mkdir(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, 'repair-artifact.json');
    const markdownPath = path.join(outputDir, 'repair-report.md');
    await writeFile(
      jsonPath,
      stableTracePilotRepairArtifactJson(artifact),
      'utf8',
    );
    await writeFile(
      markdownPath,
      renderTracePilotRepairMarkdown(artifact),
      'utf8',
    );
    console.log(`TracePilot repair artifact: ${jsonPath}`);
    console.log(`TracePilot repair report: ${markdownPath}`);
    return verificationMatrix.every((check) => check.status === 'pass') ? 0 : 1;
  } finally {
    if (provider) {
      await provider.forceFlush().catch(() => undefined);
      await provider.shutdown().catch(() => undefined);
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workdir: process.cwd(),
    outputDir: path.join('.ai-logs', 'tracepilot-check'),
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--workdir') {
      options.workdir = argv[++index] ?? options.workdir;
    } else if (arg === '--output-dir') {
      options.outputDir = argv[++index] ?? options.outputDir;
    }
  }
  return options;
}

async function buildCommandSpecs(workdir: string): Promise<CommandSpec[]> {
  return [
    {
      id: 'typecheck',
      executable: process.execPath,
      args: [
        path.join(workdir, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '-p',
        'tsconfig.json',
      ],
      required: true,
      reason: 'verify TypeScript stability',
    },
    {
      id: 'lint',
      executable: process.execPath,
      args: [path.join(workdir, 'node_modules/eslint/bin/eslint.js'), '.'],
      required: true,
      reason: 'verify static analysis stability',
    },
    {
      id: 'build',
      executable: process.execPath,
      args: [path.join(workdir, 'node_modules/typescript/bin/tsc'), '-b'],
      required: true,
      reason: 'verify build integrity',
    },
    {
      id: 'tests',
      executable: process.execPath,
      args: [
        path.join(workdir, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'vitest.config.ts',
      ],
      required: true,
      reason: 'verify regression tests',
    },
  ];
}

async function runCommand(
  workdir: string,
  spec: CommandSpec,
): Promise<CommandRun> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(spec.executable, spec.args, {
      cwd: workdir,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      spec,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const failed = getExecFailure(error);
    return {
      spec,
      exitCode: failed.exitCode,
      stdout: failed.stdout,
      stderr: failed.stderr,
      durationMs: Date.now() - startedAt,
    };
  }
}

function recordCommandSpan(sessionId: string, run: CommandRun): void {
  const preview = createRedactedOutputPreview(`${run.stdout}\n${run.stderr}`);
  const tracer = trace.getTracer('tracepilot-check-folder');
  const span = tracer.startSpan('gemini_cli.tool.shell', {
    attributes: {
      [GEN_AI_TOOL_NAME]: 'tracepilot_check_folder',
      [GEMINI_CLI_COMMAND_EXIT_CODE]: run.exitCode,
      [GEMINI_CLI_OUTPUT_PREVIEW]: preview.preview,
      [GEMINI_CLI_OUTPUT_SHA256]: preview.sha256,
      'session.id': sessionId,
      'tracepilot.command': formatCommand(run.spec),
      'tracepilot.verification.id': run.spec.id,
      'tracepilot.duration_ms': run.durationMs,
    },
  });
  if (run.exitCode !== 0) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Command failed with exit code ${run.exitCode}`,
    });
  }
  span.end();
}

function recordRepairArtifactSpan(
  sessionId: string,
  artifact: ReturnType<typeof createTracePilotRepairArtifact>,
): void {
  const tracer = trace.getTracer('tracepilot-check-folder');
  const span = tracer.startSpan('gemini_cli.chain.repair_report', {
    attributes: {
      [GEMINI_CLI_REPAIR_SIGNATURE_ID]: artifact.failure.signature.id,
      [GEMINI_CLI_REPAIR_ROOT_CAUSE]: artifact.failure.rootCause,
      [GEMINI_CLI_REPAIR_CONFIDENCE_SCORE]: artifact.confidence.score,
      [GEMINI_CLI_REPAIR_RISK_LEVEL]: artifact.safety.risk.level,
      [GEMINI_CLI_REPAIR_REGRESSION_CONFIDENCE]:
        artifact.verification.regressionConfidence,
      [GEMINI_CLI_REPAIR_VERIFICATION_PASSED]:
        artifact.verification.regressionConfidence === 1,
      'session.id': sessionId,
    },
  });
  span.end();
}

function registerPhoenixProvider(): NodeTracerProvider | undefined {
  const apiKey = process.env['PHOENIX_API_KEY'];
  const project = process.env['PHOENIX_PROJECT'];
  const url =
    process.env['PHOENIX_COLLECTOR_ENDPOINT'] ??
    process.env['PHOENIX_BASE_URL'];
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

async function readPackageVersions(
  workdir: string,
): Promise<Record<string, string>> {
  try {
    const text = await readFile(path.join(workdir, 'package.json'), 'utf8');
    const parsed = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };
  } catch {
    return {};
  }
}

function formatCommand(spec: CommandSpec): string {
  return [spec.executable, ...spec.args].join(' ');
}

function getExecFailure(error: unknown): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const record = isRecord(error) ? error : {};
  return {
    exitCode: typeof record['code'] === 'number' ? record['code'] : 1,
    stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
    stderr:
      typeof record['stderr'] === 'string' ? record['stderr'] : String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
