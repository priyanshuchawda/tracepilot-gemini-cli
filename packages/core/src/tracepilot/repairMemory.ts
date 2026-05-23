/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { stableStringify } from '../policy/stable-stringify.js';
import type { PhoenixTraceEvidence } from '../telemetry/phoenixSelfIntrospection.js';
import type { TracePilotFailureSignature } from './failureSignature.js';

export type TracePilotRepairOutcome = 'verified' | 'failed' | 'regressed';

export interface TracePilotRepairFingerprintInput {
  strategy: string[];
  filesModified: string[];
  dependencyChanges?: Record<string, string>;
  verificationCommands: string[];
}

export interface TracePilotHistoricalRepairSession {
  sessionId: string;
  traceId?: string;
  signature: TracePilotFailureSignature;
  repairFingerprint: string;
  rootCause: string;
  strategy: string[];
  outcome: TracePilotRepairOutcome;
  attempts: number;
  verificationPassed: boolean;
  regressionPassed: boolean;
  tracesConsulted: PhoenixTraceEvidence[];
}

export interface TracePilotRepairCandidate {
  session: TracePilotHistoricalRepairSession;
  similarityScore: number;
  historicalOutcomeScore: number;
  matchedReasons: string[];
}

export function createTracePilotRepairFingerprint(
  input: TracePilotRepairFingerprintInput,
): string {
  const canonical = {
    dependencyChanges: sortRecord(input.dependencyChanges),
    filesModified: [...new Set(input.filesModified.map(normalizeText))].sort(),
    strategy: [...new Set(input.strategy.map(normalizeText))].sort(),
    verificationCommands: [
      ...new Set(input.verificationCommands.map(normalizeText)),
    ].sort(),
  };
  return `tracepilot-repair-${sha256(stableStringify(canonical)).slice(0, 24)}`;
}

export function rankTracePilotHistoricalRepairs(
  current: TracePilotFailureSignature,
  historical: TracePilotHistoricalRepairSession[],
  limit = 5,
): TracePilotRepairCandidate[] {
  return historical
    .map((session) => scoreHistoricalRepair(current, session))
    .filter((candidate) => candidate.similarityScore > 0)
    .sort((a, b) => {
      const scoreDelta =
        b.similarityScore * b.historicalOutcomeScore -
        a.similarityScore * a.historicalOutcomeScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return a.session.sessionId.localeCompare(b.session.sessionId);
    })
    .slice(0, limit);
}

export function scoreHistoricalRepair(
  current: TracePilotFailureSignature,
  session: TracePilotHistoricalRepairSession,
): TracePilotRepairCandidate {
  const matchedReasons: string[] = [];
  let score = 0;

  if (current.commandFamily === session.signature.commandFamily) {
    score += 0.15;
    matchedReasons.push('command_family');
  }
  if (current.taxonomy === session.signature.taxonomy) {
    score += 0.2;
    matchedReasons.push('root_cause_taxonomy');
  }
  const diagnosticOverlap = jaccard(
    current.diagnostics,
    session.signature.diagnostics,
  );
  if (diagnosticOverlap > 0) {
    score += diagnosticOverlap * 0.25;
    matchedReasons.push('diagnostics');
  }
  const stackOverlap = jaccard(
    current.stackFrames,
    session.signature.stackFrames,
  );
  if (stackOverlap > 0) {
    score += stackOverlap * 0.1;
    matchedReasons.push('stack_frames');
  }
  const fileOverlap = jaccard(current.files, session.signature.files);
  if (fileOverlap > 0) {
    score += fileOverlap * 0.15;
    matchedReasons.push('files');
  }
  const dependencyOverlap = dependencySimilarity(
    current.dependencies,
    session.signature.dependencies,
  );
  if (dependencyOverlap > 0) {
    score += dependencyOverlap * 0.15;
    matchedReasons.push('dependencies');
  }

  return {
    session,
    similarityScore: clamp(score),
    historicalOutcomeScore: historicalOutcomeScore(session),
    matchedReasons,
  };
}

function historicalOutcomeScore(
  session: TracePilotHistoricalRepairSession,
): number {
  if (session.outcome === 'verified' && session.regressionPassed) {
    return session.attempts <= 1 ? 1 : 0.9;
  }
  if (session.outcome === 'verified') {
    return 0.75;
  }
  if (session.outcome === 'regressed') {
    return 0.25;
  }
  return 0;
}

function dependencySimilarity(
  left: Record<string, string>,
  right: Record<string, string>,
): number {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (names.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const name of names) {
    if (left[name] !== undefined && left[name] === right[name]) {
      matches++;
    }
  }
  return matches / names.size;
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) {
      intersection++;
    }
  }
  return intersection / union.size;
}

function sortRecord(
  record: Record<string, string> | undefined,
): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {}).sort()) {
    sorted[normalizeText(key)] = normalizeText(value);
  }
  return sorted;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
