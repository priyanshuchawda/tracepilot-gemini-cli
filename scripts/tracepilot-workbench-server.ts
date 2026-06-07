#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { redactSensitiveText } from '../packages/core/src/telemetry/sanitize.js';

dotenv.config({ quiet: true });

type RunMode = 'controlled' | 'live';
type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
type BenchmarkScenario =
  | 'checkout-service'
  | 'idempotency-race'
  | 'trace-ablation';

interface WorkbenchEvent {
  seq: number;
  at: string;
  type: 'status' | 'reasoning' | 'tool' | 'evidence' | 'result' | 'error';
  title: string;
  detail?: string;
  status?: 'running' | 'pass' | 'warn' | 'fail';
  data?: Record<string, unknown>;
}

interface WorkbenchRun {
  id: string;
  prompt: string;
  mode: RunMode;
  scenario: BenchmarkScenario;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  events: WorkbenchEvent[];
  clients: Set<ServerResponse>;
  child?: ChildProcess;
  result?: Record<string, unknown>;
}

interface RunContext {
  run: WorkbenchRun;
  env: NodeJS.ProcessEnv;
  emit: (event: Omit<WorkbenchEvent, 'seq' | 'at'>) => WorkbenchEvent;
  setChild: (child: ChildProcess) => void;
}

type RunExecutor = (context: RunContext) => Promise<Record<string, unknown>>;

interface WorkbenchServerOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runExecutor?: RunExecutor;
  assetDir?: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultAssetDir = path.join(scriptDir, 'tracepilot-workbench');

export function createTracePilotWorkbenchServer(
  options: WorkbenchServerOptions = {},
) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const runExecutor = options.runExecutor ?? executeBenchmarkRun;
  const assetDir = options.assetDir ?? defaultAssetDir;
  const runs = new Map<string, WorkbenchRun>();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, {
          ok: true,
          liveReady: hasLiveEnv(env),
          scenarios: [
            {
              id: 'checkout-service',
              name: 'Checkout webhook repair',
              difficulty: 'advanced',
              summary:
                'Configuration, signature verification, and credential-redaction failures.',
            },
            {
              id: 'idempotency-race',
              name: 'Duplicate settlement race',
              difficulty: 'expert',
              summary:
                'A non-atomic idempotency check exposed only through causal execution evidence.',
            },
            {
              id: 'trace-ablation',
              name: 'Blind vs Trace A/B',
              difficulty: 'measured',
              summary:
                'The same Gemini model and prompt run with and without TracePilot evidence under one fixed budget.',
            },
          ],
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/runs') {
        sendJson(
          response,
          200,
          [...runs.values()]
            .slice(-20)
            .reverse()
            .map((run) => serializeRun(run)),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const body = await readJsonBody(request);
        const prompt = validatePrompt(body['prompt']);
        const mode = validateMode(body['mode']);
        const scenario = validateScenario(body['scenario']);
        if (mode === 'live' && !hasLiveEnv(env)) {
          sendJson(response, 409, {
            ok: false,
            error: 'live_mode_unavailable',
          });
          return;
        }
        const run: WorkbenchRun = {
          id: randomUUID(),
          prompt,
          mode,
          scenario,
          status: 'queued',
          createdAt: now().toISOString(),
          events: [],
          clients: new Set(),
        };
        runs.set(run.id, run);
        sendJson(response, 202, serializeRun(run));
        void startRun(run, env, now, runExecutor);
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) {
          sendJson(response, 404, { ok: false, error: 'run_not_found' });
          return;
        }
        sendJson(response, 200, serializeRun(run, true));
        return;
      }

      const eventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsMatch) {
        const run = runs.get(eventsMatch[1]);
        if (!run) {
          sendJson(response, 404, { ok: false, error: 'run_not_found' });
          return;
        }
        attachEventStream(request, response, run);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancelMatch) {
        const run = runs.get(cancelMatch[1]);
        if (!run) {
          sendJson(response, 404, { ok: false, error: 'run_not_found' });
          return;
        }
        if (run.status === 'running' || run.status === 'queued') {
          run.status = 'canceled';
          run.child?.kill();
          publish(run, now, {
            type: 'status',
            title: 'Run canceled',
            status: 'warn',
          });
        }
        sendJson(response, 200, serializeRun(run));
        return;
      }

      if (request.method === 'GET') {
        const asset = resolveAsset(url.pathname, assetDir);
        if (asset) {
          const content = await readFile(asset.file);
          response.writeHead(200, {
            'content-type': asset.contentType,
            'cache-control': 'no-store',
          });
          response.end(content);
          return;
        }
      }

      sendJson(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: sanitize(getErrorMessage(error)),
      });
    }
  });
}

async function startRun(
  run: WorkbenchRun,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  runExecutor: RunExecutor,
): Promise<void> {
  const emit = (event: Omit<WorkbenchEvent, 'seq' | 'at'>) =>
    publish(run, now, event);
  run.status = 'running';
  emit({
    type: 'status',
    title: 'Repair run started',
    detail: run.mode === 'live' ? 'Live Gemini mode' : 'Controlled proof mode',
    status: 'running',
  });
  emit({
    type: 'reasoning',
    title: 'Plan',
    detail:
      'Reproduce the failure, inspect trace evidence, apply the smallest source-only patch, then rerun verification.',
    status: 'running',
  });
  try {
    const result = await runExecutor({
      run,
      env,
      emit,
      setChild: (child) => {
        run.child = child;
      },
    });
    if (isCanceled(run)) {
      return;
    }
    run.status = 'completed';
    run.completedAt = now().toISOString();
    run.result = result;
    emit({
      type: 'result',
      title: 'Repair completed',
      detail: summarizeResult(result),
      status: result['ok'] === true ? 'pass' : 'warn',
      data: result,
    });
  } catch (error) {
    if (isCanceled(run)) {
      return;
    }
    run.status = 'failed';
    run.completedAt = now().toISOString();
    emit({
      type: 'error',
      title: 'Repair run failed',
      detail: sanitize(getErrorMessage(error)),
      status: 'fail',
    });
  } finally {
    run.child = undefined;
    finishStreams(run);
  }
}

async function executeBenchmarkRun({
  run,
  env,
  emit,
  setChild,
}: RunContext): Promise<Record<string, unknown>> {
  const runDir = path.join(
    repoRoot,
    '.ai-logs',
    'tracepilot-workbench',
    'runs',
    run.id,
  );
  const workspace = path.join(runDir, 'workspace');
  const output = path.join(runDir, 'result.json');
  await mkdir(runDir, { recursive: true });

  emit({
    type: 'tool',
    title: 'Reproduce benchmark failure',
    detail:
      run.scenario === 'trace-ablation'
        ? 'Preparing byte-identical blind and trace-assisted production incident workspaces.'
        : run.scenario === 'idempotency-race'
          ? 'Running the duplicate-delivery invariant check in a disposable workspace.'
          : 'Running the checkout-service verification suite in a disposable workspace.',
    status: 'running',
    data: { command: 'node --test' },
  });

  const isRace = run.scenario === 'idempotency-race';
  const isAblation = run.scenario === 'trace-ablation';
  const args = ['--import', 'tsx'];
  if (isAblation) {
    args.push(
      'scripts/demo-trace-ablation.ts',
      '--output',
      output,
      '--timeout-ms',
      '120000',
    );
    if (run.mode === 'controlled') {
      args.push(
        '--agent-script',
        'scripts/testing/fake-trace-ablation-agent.mjs',
      );
    } else {
      args.push('--env-file', path.resolve('.env'));
    }
  } else {
    args.push(
      isRace
        ? 'scripts/demo-idempotency-race-repair.ts'
        : 'scripts/demo-gemini-repair-agent.ts',
      '--workdir',
      workspace,
      '--output',
      output,
      '--task',
      run.prompt,
    );
    if (run.mode === 'controlled') {
      if (!isRace) {
        args.push('--allow-missing-phoenix');
      }
      args.push(
        '--agent-script',
        isRace
          ? 'scripts/testing/fake-idempotency-repair-agent.mjs'
          : 'scripts/testing/fake-checkout-repair-agent.mjs',
      );
    } else {
      args.push('--env-file', path.resolve('.env'));
    }
  }

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  setChild(child);
  let stderr = '';
  consumeLines(child.stdout, (line) => publishProofLine(line, emit));
  consumeLines(child.stderr, (line) => {
    stderr += `${line}\n`;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `Benchmark runner exited with code ${exitCode}.`,
    );
  }
  return JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
}

function publishProofLine(line: string, emit: RunContext['emit']): void {
  const sanitized = sanitize(line.trim());
  if (!sanitized) {
    return;
  }
  const [label, remainder = ''] = sanitized.split(/:\s+/, 2);
  const definitions: Record<
    string,
    { type: WorkbenchEvent['type']; title: string }
  > = {
    INITIAL_FIXTURE_TEST: { type: 'tool', title: 'Failure reproduced' },
    AGENT_REPAIR: { type: 'reasoning', title: 'Agent repair pass' },
    MODEL_USED: { type: 'status', title: 'Model selected' },
    FAILED_TOOL_SPAN: { type: 'evidence', title: 'Failed tool span' },
    PHOENIX_MCP_INTROSPECTION: {
      type: 'evidence',
      title: 'Phoenix MCP introspection',
    },
    CAUSAL_TRACE: { type: 'evidence', title: 'Causal trace' },
    TRACE_EVIDENCE: { type: 'evidence', title: 'Race trace evidence' },
    SAFETY_BLOCK: { type: 'evidence', title: 'Safety gate' },
    FILES_CHANGED: { type: 'tool', title: 'Patch applied' },
    RETRY_TEST: { type: 'tool', title: 'Verification retry' },
    STRESS_VERIFICATION: {
      type: 'evidence',
      title: 'Repeated stress verification',
    },
    EVALS: { type: 'evidence', title: 'Deterministic evals' },
    PROOF_LEVEL: { type: 'result', title: 'Proof level' },
    SESSION_ID: { type: 'status', title: 'Trace session' },
    REPORT: { type: 'result', title: 'Evidence report' },
    MODEL: { type: 'status', title: 'Model selected' },
    PROMPT_SHA256: { type: 'evidence', title: 'Prompt fingerprint' },
    SAME_STARTING_WORKSPACE: {
      type: 'evidence',
      title: 'Identical starting workspace',
    },
    ABLATION_ARM: { type: 'evidence', title: 'Benchmark arm' },
    ABLATION_OUTCOME: { type: 'result', title: 'Measured A/B outcome' },
  };
  const configured = definitions[label];
  const definition =
    label === 'ABLATION_ARM'
      ? {
          type: configured?.type ?? 'evidence',
          title: remainder.startsWith('blind')
            ? 'Blind arm'
            : 'Trace-assisted arm',
        }
      : configured;
  if (!definition) {
    return;
  }
  const normalized = remainder.toUpperCase();
  const status =
    (label === 'ABLATION_ARM' && normalized.includes('SOLVED=FALSE')) ||
    (label === 'SAME_STARTING_WORKSPACE' && normalized !== 'TRUE')
      ? 'fail'
      : label === 'TRACE_EVIDENCE' ||
          (label === 'ABLATION_ARM' && normalized.includes('SOLVED=TRUE')) ||
          (label === 'SAME_STARTING_WORKSPACE' && normalized === 'TRUE') ||
          (label === 'ABLATION_OUTCOME' &&
            normalized.includes('TRACE_ASSISTANCE_ADVANTAGE')) ||
          normalized.includes('PASS') ||
          normalized.includes('LIVE_')
        ? 'pass'
        : normalized.includes('FAIL')
          ? 'fail'
          : normalized.includes('DEGRADED') ||
              normalized.includes('SIMULATED') ||
              normalized.includes('CONTROLLED')
            ? 'warn'
            : 'running';
  emit({
    type: definition.type,
    title: definition.title,
    detail: remainder,
    status,
  });
}

function publish(
  run: WorkbenchRun,
  now: () => Date,
  event: Omit<WorkbenchEvent, 'seq' | 'at'>,
): WorkbenchEvent {
  const complete: WorkbenchEvent = {
    ...event,
    seq: run.events.length + 1,
    at: now().toISOString(),
    detail: event.detail === undefined ? undefined : sanitize(event.detail),
  };
  run.events.push(complete);
  for (const client of run.clients) {
    writeSse(client, 'event', complete);
  }
  return complete;
}

function attachEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  run: WorkbenchRun,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  for (const event of run.events) {
    writeSse(response, 'event', event);
  }
  if (isTerminal(run.status)) {
    writeSse(response, 'done', serializeRun(run));
    response.end();
    return;
  }
  run.clients.add(response);
  const heartbeat = setInterval(
    () => response.write(': heartbeat\n\n'),
    15_000,
  );
  request.once('close', () => {
    clearInterval(heartbeat);
    run.clients.delete(response);
  });
}

function finishStreams(run: WorkbenchRun): void {
  for (const client of run.clients) {
    writeSse(client, 'done', serializeRun(run));
    client.end();
  }
  run.clients.clear();
}

function writeSse(
  response: ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function consumeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) {
    return;
  }
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer) {
      onLine(buffer);
    }
  });
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 16_384) {
      throw new Error('Request body is too large.');
    }
  }
  const value = JSON.parse(text || '{}') as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function validatePrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('A repair task is required.');
  }
  const prompt = value.trim();
  if (prompt.length < 8 || prompt.length > 1200) {
    throw new Error('Repair task must be between 8 and 1200 characters.');
  }
  if (redactSensitiveText(prompt).redacted) {
    throw new Error('Repair task must not contain secret-like values.');
  }
  return prompt;
}

function validateMode(value: unknown): RunMode {
  if (value === 'controlled' || value === 'live') {
    return value;
  }
  throw new Error('Mode must be controlled or live.');
}

function validateScenario(value: unknown): BenchmarkScenario {
  if (
    value === undefined ||
    value === 'checkout-service' ||
    value === 'idempotency-race' ||
    value === 'trace-ablation'
  ) {
    return value ?? 'checkout-service';
  }
  throw new Error('Unknown benchmark scenario.');
}

function serializeRun(run: WorkbenchRun, includeEvents = false) {
  return {
    id: run.id,
    prompt: run.prompt,
    mode: run.mode,
    scenario: run.scenario,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    result: run.result,
    ...(includeEvents ? { events: run.events } : {}),
  };
}

function resolveAsset(
  pathname: string,
  assetDir: string,
): { file: string; contentType: string } | undefined {
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  const asset = assets[pathname];
  return asset
    ? { file: path.join(assetDir, asset[0]), contentType: asset[1] }
    : undefined;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function hasLiveEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env['GEMINI_API_KEY'] &&
      env['PHOENIX_API_KEY'] &&
      env['PHOENIX_PROJECT'] &&
      (env['PHOENIX_HOST'] ||
        env['PHOENIX_BASE_URL'] ||
        env['PHOENIX_COLLECTOR_ENDPOINT']),
  );
}

function summarizeResult(result: Record<string, unknown>): string {
  if (typeof result['outcome'] === 'string') {
    const arms = Array.isArray(result['arms']) ? result['arms'] : [];
    const blind = arms.find((arm) => getRecord(arm)?.['arm'] === 'blind');
    const assisted = arms.find(
      (arm) => getRecord(arm)?.['arm'] === 'trace_assisted',
    );
    return `${result['outcome']}; blind=${getRecord(getRecord(blind)?.['hiddenAfter'])?.['score'] ?? 'unknown'} trace=${getRecord(getRecord(assisted)?.['hiddenAfter'])?.['score'] ?? 'unknown'}.`;
  }
  const proofLevel =
    typeof result['proofLevel'] === 'string' ? result['proofLevel'] : 'unknown';
  const repair = getRecord(result['repair']);
  const changedFiles = Array.isArray(repair?.['changedFiles'])
    ? repair['changedFiles'].length
    : 0;
  return `${proofLevel}; ${changedFiles} changed file(s).`;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function isCanceled(run: WorkbenchRun): boolean {
  return run.status === 'canceled';
}

function sanitize(value: string): string {
  return redactSensitiveText(value).value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMainModule()) {
  const port = Number.parseInt(process.env['PORT'] ?? '4310', 10);
  const server = createTracePilotWorkbenchServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`TracePilot workbench: http://127.0.0.1:${port}`);
  });
}
