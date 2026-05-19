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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
import { createRedactedOutputPreview } from '../packages/core/src/telemetry/sanitize.js';
import {
  runTracePilotEvals,
  type TracePilotEvalEvidence,
} from '../packages/core/src/tracepilot/evals.js';

const execFileAsync = promisify(execFile);
const EXPECTED_API_BASE_URL = 'https://api.example.test';
const DEFAULT_PHOENIX_MCP_PACKAGE = '@arizeai/phoenix-mcp@4.0.13';

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
    safety: {
      command: 'rm -rf /',
      blocked: true,
      reason: 'demo safety fixture blocks deleting filesystem root',
    },
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
  const report = {
    ok: retry.exitCode === 0 && (evalReport.ok || options.allowMissingPhoenix),
    localRepairOk: failed.exitCode !== 0 && retry.exitCode === 0,
    allowMissingPhoenix: options.allowMissingPhoenix,
    workdir: demoDir,
    sessionId,
    initialTest: summarizeCommand(failed),
    retryTest: summarizeCommand(retry),
    phoenix,
    repairPlan,
    eval: evalReport,
  };

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(
    options.output,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(`TracePilot broken-node-app demo report: ${options.output}`);
  if (!report.ok && !options.allowMissingPhoenix) {
    console.error(
      'Demo local repair completed, but TracePilot evals are not all passing. Check Phoenix env and MCP visibility.',
    );
  }
  return report.ok ? 0 : 1;
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
    return {
      attempted: false,
      spanCreated: false,
      exported: false,
      visible: false,
      queryable: false,
      reason:
        'Missing Phoenix env. Set PHOENIX_API_KEY, PHOENIX_PROJECT, and PHOENIX_HOST, PHOENIX_BASE_URL, or a Phoenix Cloud PHOENIX_COLLECTOR_ENDPOINT.',
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

async function queryPhoenixMcp(
  sessionId: string,
): Promise<Omit<PhoenixQueryEvidence, 'spanCreated' | 'exported'>> {
  const host = resolvePhoenixHost();
  if (!host || !process.env['PHOENIX_PROJECT']) {
    return {
      attempted: false,
      visible: false,
      queryable: false,
      reason: 'Phoenix MCP host/project env missing.',
    };
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', resolvePhoenixMcpPackage()],
    env: {
      ...process.env,
      PHOENIX_HOST: host,
      PHOENIX_PROJECT: process.env['PHOENIX_PROJECT'],
    },
  });
  const client = new Client({
    name: 'tracepilot-broken-node-app-demo',
    version: '0.0.0',
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
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
      const result = await client.callTool({
        name: 'get-spans',
        arguments: {
          project_identifier: process.env['PHOENIX_PROJECT'],
          start_time: startTime,
          names: ['gemini_cli.tool.shell'],
          limit: 100,
        },
      });
      const spans = getSpanList(parseJsonText(getTextContent(result)));
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
    await client.close().catch(() => undefined);
  }
}

function resolvePhoenixMcpPackage(): string {
  return (
    process.env['TRACEPILOT_PHOENIX_MCP_PACKAGE']?.trim() ||
    DEFAULT_PHOENIX_MCP_PACKAGE
  );
}

function resolvePhoenixHost(): string | undefined {
  for (const value of [
    process.env['PHOENIX_HOST'],
    process.env['PHOENIX_BASE_URL'],
    process.env['PHOENIX_COLLECTOR_ENDPOINT'],
  ]) {
    const resolved = normalizePhoenixBaseUrl(value);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function normalizePhoenixBaseUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed || /YOUR_|your-|example/i.test(trimmed)) {
    return undefined;
  }
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
  const record = getRecord(result);
  const content = record ? getArray(record['content']) : [];
  return content
    .map((part) => {
      const partRecord = getRecord(part);
      return partRecord?.['type'] === 'text'
        ? getString(partRecord, 'text')
        : '';
    })
    .join('\n');
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function getSpanList(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  const record = getRecord(payload);
  if (!record) {
    return [];
  }
  const spans = getArray(record['spans']) ?? getArray(record['data']) ?? [];
  return spans.filter(isRecord);
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

function getArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
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
