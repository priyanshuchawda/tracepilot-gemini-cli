# Phoenix Repair-Memory Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict two-session demo proving Gemini consumes a verified prior
Phoenix repair outcome through MCP.

**Architecture:** Extend the current strict repair runner to publish a sanitized
verified outcome span only after successful verification. Narrow core historical
lookup to verified outcome spans, then add a replay orchestrator that executes
seed and replay sessions and gates PASS output on the replay plan referencing
the seed outcome.

**Tech Stack:** TypeScript, Gemini CLI, `@arizeai/phoenix-otel`,
`@arizeai/phoenix-mcp`, Vitest, Node.js scripts.

---

### Task 1: Verified Repair Outcome Recording

**Files:**

- Modify: `scripts/demo-gemini-repair-agent.ts`
- Test: `scripts/tests/strong-agent-repair-demo.test.ts`

- [ ] Add a failing test expectation for verified outcome recording behavior.
- [ ] Run the focused script test and observe the correct failure.
- [ ] Emit a sanitized `gemini_cli.chain.repair_report` span after strict real
      repair success, with signature/fingerprint/strategy/verification
      attributes.
- [ ] Keep the offline substitute explicitly degraded rather than claiming a
      Phoenix outcome.
- [ ] Run the focused test and formatter/linter.

### Task 2: Truthful Historical Query Surface

**Files:**

- Modify: `packages/core/src/telemetry/phoenixSelfIntrospection.ts`
- Modify: `packages/core/src/telemetry/phoenixSelfIntrospection.test.ts`

- [ ] Add a failing assertion that historical lookup requests only
      `gemini_cli.chain.repair_report`.
- [ ] Run the focused core test and observe the expected red result.
- [ ] Narrow historical query arguments to verified report spans.
- [ ] Run the focused test and ensure extraction/redaction tests remain green.

### Task 3: Two-Run Replay Command

**Files:**

- Create: `scripts/demo-phoenix-repair-memory-replay.ts`
- Create: `scripts/tests/phoenix-repair-memory-replay.test.ts`
- Modify: `package.json`

- [ ] Add a failing offline contract test for proof-line/report formatting.
- [ ] Implement seed/replay orchestration with strict Phoenix MCP query support
      and an injected deterministic test path.
- [ ] Require the replay plan telemetry to identify the seed session as a
      historical memory candidate.
- [ ] Write only sanitized combined result JSON and concise proof lines.
- [ ] Run script tests, lint, and format checks.

### Task 4: Documentation And Live Proof

**Files:**

- Modify: `docs/tracepilot.md`
- Modify: `docs/tracepilot-release-demo-checklist.md`

- [ ] Document the two-run video command and exact proof lines.
- [ ] Install dependencies/build the merged CLI in the isolated worktree.
- [ ] Run `npm run typecheck`, `npm run lint`, and `npm run test:tracepilot`.
- [ ] Run Phoenix smoke checks against local `.env` without displaying keys.
- [ ] Run the strict replay demo and capture only PASS/FAIL proof lines.

### Task 5: Publish Issue #90

- [ ] Inspect staged scope and scan for credentials.
- [ ] Commit with an issue-scoped conventional message.
- [ ] Push `feat/90-phoenix-repair-memory-replay`.
- [ ] Open a ready PR closing issue #90 with concise verification evidence.
- [ ] Merge after required checks pass and remove the merged feature branch.
