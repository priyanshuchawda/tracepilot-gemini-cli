/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TRACEPILOT_EVAL_IDS,
  runTracePilotEvals,
  validateTracePilotEvalReport,
  type TracePilotEvalEvidence,
} from './evals.js';

describe('TracePilot deterministic eval runner', () => {
  it('passes all required deterministic evals with sanitized evidence', () => {
    const report = runTracePilotEvals(makePassingEvidence());

    expect(report.ok).toBe(true);
    expect(report.results.map((result) => result.id)).toEqual(
      REQUIRED_TRACEPILOT_EVAL_IDS,
    );
    expect(report.results.every((result) => result.status === 'pass')).toBe(
      true,
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-proj-secret');
    expect(serialized).not.toContain('AIzaSecret');
    expect(serialized).not.toContain('ghp_secret');
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('redis-password');
    expect(serialized).toContain('[REDACTED]');
  });

  it('fails required evals when behavioral evidence is missing', () => {
    const report = runTracePilotEvals({});

    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(REQUIRED_TRACEPILOT_EVAL_IDS.length);
    expect(report.results.every((result) => result.status === 'fail')).toBe(
      true,
    );
    expect(
      report.results.map((result) => result.failureReason).filter(Boolean),
    ).toHaveLength(REQUIRED_TRACEPILOT_EVAL_IDS.length);
  });

  it('fails redaction evidence that still leaks secrets while sanitizing output JSON', () => {
    const evidence = makePassingEvidence();
    evidence.redaction = {
      samples: [
        {
          input: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
          output: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
        },
      ],
    };

    const report = runTracePilotEvals(evidence);
    const redaction = report.results.find(
      (result) => result.id === 'secret_redaction_success',
    );

    expect(report.ok).toBe(false);
    expect(redaction?.status).toBe('fail');
    expect(JSON.stringify(report)).not.toContain('sk-proj-secret');
  });

  it('requires observed safety-block evidence', () => {
    const evidence = makePassingEvidence();
    evidence.safety = {
      command: 'rm -rf /',
      blocked: true,
      reason: 'hardcoded fixture without observed policy decision',
    };

    const report = runTracePilotEvals(evidence);
    const safety = report.results.find(
      (result) => result.id === 'blocked_destructive_command',
    );

    expect(report.ok).toBe(false);
    expect(safety?.status).toBe('fail');
  });

  it('fails closed on malformed eval evidence with sanitized errors', () => {
    expect(() =>
      runTracePilotEvals({
        command: {
          completed: 'yes',
          outputPreview: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
        },
      } as unknown as TracePilotEvalEvidence),
    ).toThrow(/Invalid TracePilot eval evidence/);
    expect(() =>
      runTracePilotEvals({
        command: {
          completed: 'yes',
          outputPreview: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
        },
      } as unknown as TracePilotEvalEvidence),
    ).not.toThrow(/sk-proj-secret/);
  });

  it('rejects malformed eval reports crossing JSON boundaries', () => {
    expect(() =>
      validateTracePilotEvalReport({
        ok: true,
        generatedAt: '2026-05-26T00:00:00.000Z',
        results: [
          {
            id: 'unexpected_eval',
            status: 'pass',
            deterministic: true,
            evidence: {},
          },
        ],
      }),
    ).toThrow(/Invalid TracePilot eval report/);
  });
});

function makePassingEvidence(): TracePilotEvalEvidence {
  return {
    command: {
      command: 'npm test',
      completed: true,
      exitCode: 0,
      outputPreview: 'ok',
      outputSha256: 'a'.repeat(64),
    },
    test: {
      command: 'npm test',
      passed: true,
      exitCode: 0,
    },
    safety: {
      command: 'rm -rf /',
      blocked: true,
      observed: true,
      level: 'blocked',
      reason: 'blocked destructive command',
    },
    redaction: {
      samples: [
        {
          input:
            'OPENAI_API_KEY=sk-proj-secret0000000000000000 GEMINI_API_KEY=AIzaSecret0000000000000000',
          output: 'OPENAI_API_KEY=[REDACTED] GEMINI_API_KEY=[REDACTED]',
        },
        {
          input: 'Authorization: Bearer ghp_secret0000000000000000',
          output: 'Authorization: [REDACTED]',
        },
        {
          input:
            'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE REDIS_URL=redis://default:redis-password@example.com:6379/0',
          output:
            'AWS_ACCESS_KEY_ID=[REDACTED] REDIS_URL=redis://[REDACTED]@example.com:6379/0',
        },
      ],
    },
    phoenix: {
      spanCreated: true,
      exported: true,
      visible: true,
      queryable: true,
      sessionId: 'tracepilot-test-session',
      traceId: 'trace-id',
    },
    selfIntrospection: {
      triggered: true,
      queryAttempted: true,
      evidenceAttached: true,
      evidenceText:
        'TracePilot Phoenix evidence for repair plan:\nspan=gemini_cli.tool.shell',
    },
    repair: {
      planCreated: true,
      referencedTraceEvidence: true,
      fixApplied: true,
      retryExitCode: 0,
      evalLogged: true,
    },
  };
}
