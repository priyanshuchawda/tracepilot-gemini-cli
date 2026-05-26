/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { runTracePilotEvals } from './evals.js';
import {
  stableTracePilotProofReportJson,
  validateTracePilotProofReport,
} from './proofReport.js';
import { TRACEPILOT_PROOF_LEVELS } from './proofLevel.js';

describe('TracePilot proof report runtime schema', () => {
  it('accepts valid offline and strict-live proof reports', () => {
    const offline = makeReport({
      proofLevel: TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE,
      strictLiveProof: false,
    });
    const live = makeReport({
      proofLevel: TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX,
      strictLiveProof: true,
      phoenix: {
        visible: true,
        queryable: true,
        traceId: 'trace-id',
        spanId: 'span-id',
      },
    });

    expect(validateTracePilotProofReport(offline).proofLevel).toBe(
      'local_offline',
    );
    expect(validateTracePilotProofReport(live).strictLiveProof).toBe(true);
    expect(stableTracePilotProofReportJson(offline)).toContain(
      '"proofLevel":"local_offline"',
    );
  });

  it('rejects missing and unknown proof-level fields', () => {
    expect(() =>
      validateTracePilotProofReport({
        ok: true,
        strictLiveProof: false,
        proofSummary: 'missing proof level',
        eval: makeEvalReport(),
      }),
    ).toThrow(/Invalid TracePilot proof report/);

    expect(() =>
      validateTracePilotProofReport(
        makeReport({
          proofLevel: 'claimed_live',
          strictLiveProof: true,
        }),
      ),
    ).toThrow(/Invalid TracePilot proof report/);
  });

  it('rejects inconsistent strict-live claims', () => {
    expect(() =>
      validateTracePilotProofReport(
        makeReport({
          proofLevel: TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE,
          strictLiveProof: true,
        }),
      ),
    ).toThrow(/strictLiveProof must match proofLevel/);
  });

  it('blocks secret-bearing proof output with sanitized diagnostics', () => {
    const report = makeReport({
      proofLevel: TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE,
      strictLiveProof: false,
      leaked: 'GEMINI_API_KEY=AIzaSecret0000000000000000',
    });

    expect(() => stableTracePilotProofReportJson(report)).toThrow(
      /secret-like value/,
    );
    expect(() => stableTracePilotProofReportJson(report)).not.toThrow(
      /AIzaSecret/,
    );
  });

  it('validates model and fallback metadata when present', () => {
    expect(() =>
      validateTracePilotProofReport(
        makeReport({
          agent: {
            model: 'gemini-test',
            quotaFallbackUsed: 'yes',
            attempts: [{ model: 'gemini-test', exitCode: 0 }],
          },
        }),
      ),
    ).toThrow(/Invalid TracePilot proof report/);
  });
});

function makeReport(overrides: Record<string, unknown>) {
  return {
    ok: true,
    proofLevel: TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE,
    strictLiveProof: false,
    proofSummary: 'Local deterministic proof only.',
    sessionId: 'tracepilot-session',
    eval: makeEvalReport(),
    ...overrides,
  };
}

function makeEvalReport() {
  return runTracePilotEvals({
    command: {
      completed: true,
      exitCode: 0,
    },
    test: {
      passed: true,
      exitCode: 0,
    },
    safety: {
      blocked: true,
      observed: true,
    },
    redaction: {
      samples: [
        {
          input: 'OPENAI_API_KEY=sk-proj-secret0000000000000000',
          output: 'OPENAI_API_KEY=[REDACTED]',
        },
      ],
    },
    phoenix: {
      spanCreated: true,
      exported: true,
      visible: true,
      queryable: true,
    },
    selfIntrospection: {
      triggered: true,
      queryAttempted: true,
      evidenceAttached: true,
    },
    repair: {
      planCreated: true,
      referencedTraceEvidence: true,
      fixApplied: true,
      retryExitCode: 0,
      evalLogged: true,
    },
  });
}
