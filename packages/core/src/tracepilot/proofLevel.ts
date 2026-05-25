/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const TRACEPILOT_PROOF_LEVELS = {
  LOCAL_OFFLINE: 'local_offline',
  CONTROLLED_SUBSTITUTE: 'controlled_substitute',
  DEGRADED_GEMINI: 'degraded_gemini',
  LIVE_PHOENIX: 'live_phoenix',
  LIVE_GEMINI_PHOENIX: 'live_gemini_phoenix',
  HOSTED_CLOUD_RUN: 'hosted_cloud_run',
} as const;

export type TracePilotProofLevel =
  (typeof TRACEPILOT_PROOF_LEVELS)[keyof typeof TRACEPILOT_PROOF_LEVELS];

export function isStrictTracePilotProofLevel(
  proofLevel: TracePilotProofLevel,
): boolean {
  return (
    proofLevel === TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX ||
    proofLevel === TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX ||
    proofLevel === TRACEPILOT_PROOF_LEVELS.HOSTED_CLOUD_RUN
  );
}

export function describeTracePilotProofLevel(
  proofLevel: TracePilotProofLevel,
): string {
  switch (proofLevel) {
    case TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE:
      return 'Local deterministic proof only; live Phoenix/Gemini evidence is absent or explicitly allowed missing.';
    case TRACEPILOT_PROOF_LEVELS.CONTROLLED_SUBSTITUTE:
      return 'Controlled substitute proof for report formatting and local repair behavior; not autonomous Gemini or live Phoenix proof.';
    case TRACEPILOT_PROOF_LEVELS.DEGRADED_GEMINI:
      return 'Gemini path ran without the full live Phoenix MCP causal proof required for strict evidence.';
    case TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX:
      return 'Live Phoenix evidence is exported and queryable, but the repair is deterministic rather than autonomous Gemini.';
    case TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX:
      return 'Autonomous Gemini repair plus live Phoenix MCP causal evidence and deterministic gates.';
    case TRACEPILOT_PROOF_LEVELS.HOSTED_CLOUD_RUN:
      return 'Hosted Cloud Run endpoint proof for the deployed TracePilot service.';
    default: {
      const exhaustive: never = proofLevel;
      return exhaustive;
    }
  }
}
