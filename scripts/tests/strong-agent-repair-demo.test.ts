/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('scripts/demo-gemini-repair-agent.ts', () => {
  it('reports a concise local agent proof without leaking secrets', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-strong-demo-'));
    const workdir = path.join(dir, 'workdir');
    const output = path.join(dir, 'result.json');

    const stdout = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-gemini-repair-agent.ts',
        '--allow-missing-phoenix',
        '--agent-script',
        'scripts/testing/fake-checkout-repair-agent.mjs',
        '--workdir',
        workdir,
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    ).toString('utf8');

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(stdout).toContain(
      'PROOF_LEVEL: controlled_substitute strictLiveProof=false',
    );
    expect(stdout).toContain('AGENT_REPAIR: PASS');
    expect(stdout).toContain('PHOENIX_MCP_INTROSPECTION: DEGRADED');
    expect(stdout).toContain('CAUSAL_TRACE: DEGRADED');
    expect(stdout).toContain('SAFETY_BLOCK: PASS');
    expect(stdout).toContain('VERIFIED_REPAIR_RECORDED: DEGRADED');
    expect(stdout).toContain('FILES_CHANGED: PASS count=3');
    expect(stdout).toContain('RETRY_TEST: PASS');
    expect(stdout).toContain(`REPORT: ${output}`);
    expect(report.ok).toBe(true);
    expect(report.proofLevel).toBe('controlled_substitute');
    expect(report.strictLiveProof).toBe(false);
    expect(report.proofSummary).toContain(
      'not autonomous Gemini or live Phoenix proof',
    );
    expect(report.agent.mode).toBe('substitute');
    expect(report.repair.changedFiles).toHaveLength(3);
    expect(report.repairArtifact).toMatchObject({
      phase: 'failed',
      repair: {
        filesModified: ['src/config.js', 'src/redact.js', 'src/signature.js'],
      },
      completion: {
        attempts: 1,
        finalExitCode: 0,
        verificationPassed: false,
      },
    });
    expect(report.repair.verifiedOutcomeRecorded).toBe(false);
    expect(report.causalTrace.chainComplete).toBe(false);
    expect(
      report.eval.results.find(
        (result: { id: string }) => result.id === 'blocked_destructive_command',
      )?.evidence,
    ).toMatchObject({ observed: true, level: 'blocked' });
    expect(report.eval.results).toHaveLength(7);
    expect(JSON.stringify(report)).not.toContain('videoSecretToken');
  }, 180000);

  it('falls back after a quota-limited model attempt', async () => {
    const { mkdtempSync, readFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-quota-demo-'));
    const output = path.join(dir, 'result.json');

    const stdout = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-gemini-repair-agent.ts',
        '--allow-missing-phoenix',
        '--agent-script',
        'scripts/testing/fake-quota-then-repair-agent.mjs',
        '--model',
        'quota-model',
        '--model-fallbacks',
        'repair-model',
        '--workdir',
        path.join(dir, 'workdir'),
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    ).toString('utf8');

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(stdout).toContain('PROOF_LEVEL: controlled_substitute');
    expect(stdout).toContain('MODEL_USED: repair-model attempts=2');
    expect(report.proofLevel).toBe('controlled_substitute');
    expect(stdout).toContain('MODEL_FALLBACK: PASS reason=quota');
    expect(report.ok).toBe(true);
    expect(report.agent.model).toBe('repair-model');
    expect(report.agent.quotaFallbackUsed).toBe(true);
    expect(report.agent.attempts).toHaveLength(2);
  }, 180000);

  it('clears the isolated Gemini session before retrying a fallback model', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'tracepilot-cli-fallback-'));
    const output = path.join(dir, 'result.json');
    const fakeCli = path.join(dir, 'fake-cli.mjs');
    writeFileSync(
      fakeCli,
      `
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1] ?? '';
const model = args[args.indexOf('--model') + 1];
const sessionId = args[args.indexOf('--session-id') + 1];
const sessionMarker = path.join(process.env.GEMINI_CLI_HOME, '.gemini', sessionId);

if (!prompt.includes('config, signature, and redaction')) {
  console.error('Prompt did not identify all checkout repair surfaces.');
  process.exit(43);
}
if (!prompt.includes('exact expected literals and signature formats')) {
  console.error('Prompt did not require deriving exact test expectations.');
  process.exit(44);
}

if (model === 'quota-model') {
  await mkdir(path.dirname(sessionMarker), { recursive: true });
  await writeFile(sessionMarker, 'created by quota attempt', 'utf8');
  console.error('TerminalQuotaError: quota exhausted');
  process.exit(1);
}

if (existsSync(sessionMarker)) {
  console.error('Error starting session: Session ID already exists.');
  process.exit(42);
}

await writeFile(path.join(process.cwd(), 'src', 'config.js'), \`
export function getPaymentBaseUrl(env = globalThis.process?.env ?? {}) {
  return env.PAYMENTS_BASE_URL ?? 'https://payments.example.test';
}
\`, 'utf8');
await writeFile(path.join(process.cwd(), 'src', 'signature.js'), \`
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyWebhookSignature(payload, provided, secret) {
  const expected = \\\`sha256=\\\${createHmac('sha256', secret).update(payload).digest('hex')}\\\`;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}
\`, 'utf8');
await writeFile(path.join(process.cwd(), 'src', 'redact.js'), \`
export function redactDiagnostic(value) {
  return value
    .replace(/PAYMENTS_API_KEY=[^\\\\s]+/g, 'PAYMENTS_API_KEY=[REDACTED]')
    .replace(/(Authorization:\\\\s*Bearer\\\\s+)[^\\\\s]+/gi, '$1[REDACTED]');
}
\`, 'utf8');
console.log(JSON.stringify({ type: 'result', status: 'success' }));
`,
      'utf8',
    );

    const stdout = execFileSync(
      'node',
      [
        '--import',
        'tsx',
        'scripts/demo-gemini-repair-agent.ts',
        '--allow-missing-phoenix',
        '--cli-path',
        fakeCli,
        '--model',
        'quota-model',
        '--model-fallbacks',
        'repair-model',
        '--workdir',
        path.join(dir, 'workdir'),
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PHOENIX_API_KEY: '',
          PHOENIX_HOST: '',
          PHOENIX_PROJECT: '',
          PHOENIX_BASE_URL: '',
          PHOENIX_COLLECTOR_ENDPOINT: '',
        },
        stdio: 'pipe',
      },
    ).toString('utf8');

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(stdout).toContain('MODEL_FALLBACK: PASS reason=quota');
    expect(report.ok).toBe(true);
    expect(report.agent.model).toBe('repair-model');
    expect(report.agent.quotaFallbackUsed).toBe(true);
    expect(report.agent.attempts).toHaveLength(2);
  }, 180000);
});
