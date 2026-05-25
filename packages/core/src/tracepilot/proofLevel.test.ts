/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  describeTracePilotProofLevel,
  isStrictTracePilotProofLevel,
  TRACEPILOT_PROOF_LEVELS,
} from './proofLevel.js';

describe('TracePilot proof levels', () => {
  it('separates local or substitute proof from strict live proof', () => {
    expect(
      isStrictTracePilotProofLevel(TRACEPILOT_PROOF_LEVELS.LOCAL_OFFLINE),
    ).toBe(false);
    expect(
      isStrictTracePilotProofLevel(
        TRACEPILOT_PROOF_LEVELS.CONTROLLED_SUBSTITUTE,
      ),
    ).toBe(false);
    expect(
      isStrictTracePilotProofLevel(TRACEPILOT_PROOF_LEVELS.DEGRADED_GEMINI),
    ).toBe(false);
    expect(
      isStrictTracePilotProofLevel(TRACEPILOT_PROOF_LEVELS.LIVE_PHOENIX),
    ).toBe(true);
    expect(
      isStrictTracePilotProofLevel(TRACEPILOT_PROOF_LEVELS.LIVE_GEMINI_PHOENIX),
    ).toBe(true);
    expect(
      isStrictTracePilotProofLevel(TRACEPILOT_PROOF_LEVELS.HOSTED_CLOUD_RUN),
    ).toBe(true);
  });

  it('describes controlled substitute proof without implying live evidence', () => {
    expect(
      describeTracePilotProofLevel(
        TRACEPILOT_PROOF_LEVELS.CONTROLLED_SUBSTITUTE,
      ),
    ).toContain('not autonomous Gemini or live Phoenix proof');
  });
});
