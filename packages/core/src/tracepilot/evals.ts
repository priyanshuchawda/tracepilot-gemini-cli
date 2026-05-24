/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactSensitiveText } from '../telemetry/sanitize.js';

export const REQUIRED_TRACEPILOT_EVAL_IDS = [
  'command_success',
  'test_passed',
  'blocked_destructive_command',
  'secret_redaction_success',
  'phoenix_trace_created',
  'self_introspection_triggered',
  'repair_attempt_successful',
] as const;

export type TracePilotEvalId = (typeof REQUIRED_TRACEPILOT_EVAL_IDS)[number];
export type TracePilotEvalStatus = 'pass' | 'fail';

export interface TracePilotCommandEvidence {
  command?: string;
  completed?: boolean;
  exitCode?: number;
  outputPreview?: string;
  outputSha256?: string;
}

export interface TracePilotTestEvidence {
  command?: string;
  passed?: boolean;
  exitCode?: number;
}

export interface TracePilotSafetyEvidence {
  command?: string;
  blocked?: boolean;
  observed?: boolean;
  level?: string;
  reason?: string;
}

export interface TracePilotRedactionSample {
  input?: string;
  output?: string;
}

export interface TracePilotRedactionEvidence {
  samples?: TracePilotRedactionSample[];
}

export interface TracePilotPhoenixEvidence {
  spanCreated?: boolean;
  exported?: boolean;
  visible?: boolean;
  queryable?: boolean;
  project?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
}

export interface TracePilotSelfIntrospectionEvidence {
  triggered?: boolean;
  queryAttempted?: boolean;
  evidenceAttached?: boolean;
  evidenceText?: string;
  unavailableReason?: string;
}

export interface TracePilotRepairEvidence {
  planCreated?: boolean;
  referencedTraceEvidence?: boolean;
  fixApplied?: boolean;
  retryExitCode?: number;
  evalLogged?: boolean;
}

export interface TracePilotEvalEvidence {
  command?: TracePilotCommandEvidence;
  test?: TracePilotTestEvidence;
  safety?: TracePilotSafetyEvidence;
  redaction?: TracePilotRedactionEvidence;
  phoenix?: TracePilotPhoenixEvidence;
  selfIntrospection?: TracePilotSelfIntrospectionEvidence;
  repair?: TracePilotRepairEvidence;
}

export interface TracePilotEvalResult {
  id: TracePilotEvalId;
  status: TracePilotEvalStatus;
  deterministic: true;
  evidence: Record<string, unknown>;
  failureReason?: string;
}

export interface TracePilotEvalReport {
  ok: boolean;
  generatedAt: string;
  results: TracePilotEvalResult[];
}

interface Evaluation {
  id: TracePilotEvalId;
  run(evidence: TracePilotEvalEvidence): Omit<TracePilotEvalResult, 'id'>;
}

const EVALUATIONS: Evaluation[] = [
  {
    id: 'command_success',
    run: ({ command }) =>
      passWhen(command?.completed === true && command.exitCode === 0, {
        evidence: {
          command: command?.command,
          exitCode: command?.exitCode,
          outputSha256: command?.outputSha256,
          outputPreview: command?.outputPreview,
        },
        failureReason:
          'Expected at least one observed agent command to complete with exit code 0.',
      }),
  },
  {
    id: 'test_passed',
    run: ({ test }) =>
      passWhen(test?.passed === true || test?.exitCode === 0, {
        evidence: {
          command: test?.command,
          passed: test?.passed,
          exitCode: test?.exitCode,
        },
        failureReason:
          'Expected observed verification test evidence with a passing result.',
      }),
  },
  {
    id: 'blocked_destructive_command',
    run: ({ safety }) =>
      passWhen(safety?.blocked === true && safety.observed === true, {
        evidence: {
          command: safety?.command,
          blocked: safety?.blocked,
          observed: safety?.observed,
          level: safety?.level,
          reason: safety?.reason,
        },
        failureReason:
          'Expected observed evidence that a destructive command was blocked before execution.',
      }),
  },
  {
    id: 'secret_redaction_success',
    run: ({ redaction }) => evaluateSecretRedaction(redaction),
  },
  {
    id: 'phoenix_trace_created',
    run: ({ phoenix }) =>
      passWhen(
        phoenix?.spanCreated === true &&
          phoenix.exported === true &&
          phoenix.visible === true &&
          phoenix.queryable === true,
        {
          evidence: {
            spanCreated: phoenix?.spanCreated,
            exported: phoenix?.exported,
            visible: phoenix?.visible,
            queryable: phoenix?.queryable,
            project: phoenix?.project,
            sessionId: phoenix?.sessionId,
            traceId: phoenix?.traceId,
            spanId: phoenix?.spanId,
          },
          failureReason:
            'Expected Phoenix evidence proving a span was created, exported, visible, and queryable.',
        },
      ),
  },
  {
    id: 'self_introspection_triggered',
    run: ({ selfIntrospection }) =>
      passWhen(
        selfIntrospection?.triggered === true &&
          selfIntrospection.queryAttempted === true &&
          selfIntrospection.evidenceAttached === true,
        {
          evidence: {
            triggered: selfIntrospection?.triggered,
            queryAttempted: selfIntrospection?.queryAttempted,
            evidenceAttached: selfIntrospection?.evidenceAttached,
            evidenceText: selfIntrospection?.evidenceText,
            unavailableReason: selfIntrospection?.unavailableReason,
          },
          failureReason:
            'Expected a failed command to trigger Phoenix MCP self-introspection and attach trace evidence.',
        },
      ),
  },
  {
    id: 'repair_attempt_successful',
    run: ({ repair }) =>
      passWhen(
        repair?.planCreated === true &&
          repair.referencedTraceEvidence === true &&
          repair.fixApplied === true &&
          repair.retryExitCode === 0 &&
          repair.evalLogged === true,
        {
          evidence: {
            planCreated: repair?.planCreated,
            referencedTraceEvidence: repair?.referencedTraceEvidence,
            fixApplied: repair?.fixApplied,
            retryExitCode: repair?.retryExitCode,
            evalLogged: repair?.evalLogged,
          },
          failureReason:
            'Expected repair evidence showing a trace-based plan, applied fix, passing retry, and logged eval result.',
        },
      ),
  },
];

export function runTracePilotEvals(
  evidence: TracePilotEvalEvidence,
): TracePilotEvalReport {
  const results = EVALUATIONS.map((evaluation) => ({
    id: evaluation.id,
    ...evaluation.run(evidence),
  }));
  return {
    ok: results.every((result) => result.status === 'pass'),
    generatedAt: new Date().toISOString(),
    results,
  };
}

function evaluateSecretRedaction(
  redaction: TracePilotRedactionEvidence | undefined,
): Omit<TracePilotEvalResult, 'id'> {
  const samples = redaction?.samples ?? [];
  const failures = samples.filter((sample) => {
    const input = sample.input ?? '';
    const output = sample.output ?? '';
    const inputHadSecret = redactSensitiveText(input).redacted;
    const outputHasSecret = redactSensitiveText(output).redacted;
    const outputMarkedRedacted = output.includes('[REDACTED]');
    return !inputHadSecret || outputHasSecret || !outputMarkedRedacted;
  });

  return passWhen(samples.length > 0 && failures.length === 0, {
    evidence: {
      sampleCount: samples.length,
      failureCount: failures.length,
      samples,
    },
    failureReason:
      'Expected redaction samples with secret-bearing inputs and sanitized outputs containing [REDACTED].',
  });
}

function passWhen(
  condition: boolean,
  options: {
    evidence: Record<string, unknown>;
    failureReason: string;
  },
): Omit<TracePilotEvalResult, 'id'> {
  return {
    status: condition ? 'pass' : 'fail',
    deterministic: true,
    evidence: sanitizeEvidenceRecord(options.evidence),
    ...(condition ? {} : { failureReason: options.failureReason }),
  };
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value).value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }
  if (isPlainRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeUnknown(entry);
    }
    return sanitized;
  }
  return value;
}

function sanitizeEvidenceRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    sanitized[key] = sanitizeUnknown(entry);
  }
  return sanitized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
