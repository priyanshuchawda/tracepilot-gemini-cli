/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TRACEPILOT_EVAL_IDS,
  runTracePilotEvals,
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
