/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTracePilotWorkbenchServer } from '../tracepilot-workbench-server.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('scripts/tracepilot-workbench-server.ts', () => {
  it('serves the workbench and reports controlled-only readiness without live env', async () => {
    const baseUrl = await startServer(
      createTracePilotWorkbenchServer({ env: {} }),
    );

    const html = await fetch(`${baseUrl}/`).then((response) => response.text());
    const status = await fetch(`${baseUrl}/api/status`).then((response) =>
      response.json(),
    );

    expect(html).toContain('TracePilot');
    expect(html).toContain('activity-stream');
    expect(status).toMatchObject({
      ok: true,
      liveReady: false,
      scenarios: [
        { id: 'checkout-service', difficulty: 'advanced' },
        { id: 'idempotency-race', difficulty: 'expert' },
      ],
    });
  });

  it('validates tasks and rejects secret-like prompt content', async () => {
    const baseUrl = await startServer(
      createTracePilotWorkbenchServer({ env: {} }),
    );

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
        mode: 'controlled',
        scenario: 'checkout-service',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain('must not contain secret-like values');
    expect(JSON.stringify(payload)).not.toContain('sk-proj-secret');
  });

  it('replays structured events over SSE', async () => {
    const baseUrl = await startServer(
      createTracePilotWorkbenchServer({
        env: {},
        runExecutor: async ({ emit }) => {
          emit({
            type: 'tool',
            title: 'Verification retry',
            detail: 'node --test',
            status: 'pass',
          });
          return {
            ok: true,
            proofLevel: 'controlled_substitute',
            strictLiveProof: false,
            sessionId: 'workbench-test-session',
            repair: { changedFiles: ['src/config.js'] },
          };
        },
      }),
    );
    const created = await createRun(baseUrl);

    const stream = await fetch(`${baseUrl}/api/runs/${created.id}/events`).then(
      (response) => response.text(),
    );
    const run = await fetch(`${baseUrl}/api/runs/${created.id}`).then(
      (response) => response.json(),
    );

    expect(stream).toContain('event: event');
    expect(stream).toContain('Verification retry');
    expect(stream).toContain('event: done');
    expect(run).toMatchObject({
      status: 'completed',
      result: {
        ok: true,
        proofLevel: 'controlled_substitute',
      },
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', title: 'Plan' }),
        expect.objectContaining({
          type: 'tool',
          title: 'Verification retry',
        }),
      ]),
    );
  });

  it('completes a controlled checkout repair through the workbench backend', async () => {
    const baseUrl = await startServer(
      createTracePilotWorkbenchServer({ env: {} }),
    );
    const created = await createRun(baseUrl);
    const run = await waitForTerminalRun(baseUrl, created.id);

    expect(run).toMatchObject({
      status: 'completed',
      mode: 'controlled',
      result: {
        ok: true,
        proofLevel: 'controlled_substitute',
        strictLiveProof: false,
        repair: {
          changedFiles: ['src/config.js', 'src/redact.js', 'src/signature.js'],
          onlyExpectedFilesChanged: true,
        },
      },
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Failure reproduced',
          status: 'fail',
        }),
        expect.objectContaining({ title: 'Safety gate', status: 'pass' }),
        expect.objectContaining({
          title: 'Verification retry',
          status: 'pass',
        }),
      ]),
    );
  }, 30000);

  it('completes the trace-dependent idempotency race benchmark', async () => {
    const baseUrl = await startServer(
      createTracePilotWorkbenchServer({ env: {} }),
    );
    const created = await createRun(baseUrl, 'idempotency-race');
    const run = await waitForTerminalRun(baseUrl, created.id);

    expect(run).toMatchObject({
      status: 'completed',
      scenario: 'idempotency-race',
      result: {
        ok: true,
        proofLevel: 'controlled_trace_assisted',
        competitorClaimsMeasured: false,
        traceEvidence: {
          rootCause: 'non_atomic_check_then_commit',
          observedSettlements: 2,
          missesBeforeFirstCommit: 2,
        },
        repair: {
          changedFiles: ['src/ledger.js'],
          onlyExpectedFilesChanged: true,
        },
        stressVerification: {
          runs: 20,
          failures: 0,
        },
      },
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Race trace evidence',
          status: 'pass',
        }),
        expect.objectContaining({
          title: 'Repeated stress verification',
          status: 'pass',
        }),
      ]),
    );
  }, 60000);
});

async function startServer(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function createRun(baseUrl: string, scenario = 'checkout-service') {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt:
        'Repair the checkout webhook service and verify every failing behavior.',
      mode: 'controlled',
      scenario,
    }),
  });
  expect(response.status).toBe(202);
  return response.json();
}

async function waitForTerminalRun(baseUrl: string, runId: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const run = await fetch(`${baseUrl}/api/runs/${runId}`).then((response) =>
      response.json(),
    );
    if (['completed', 'failed', 'canceled'].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Workbench run did not reach a terminal state.');
}
