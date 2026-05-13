# TracePilot Verification

TracePilot is a Gemini CLI fork focused on proving an agent repair loop with
Phoenix observability. The implementation is intentionally split between local
deterministic checks and Phoenix Cloud checks that require real credentials.

## Required Environment

Create a local `.env` from `.env.example` and fill in real values:

```bash
GEMINI_API_KEY=
PHOENIX_API_KEY=
PHOENIX_HOST=https://app.phoenix.arize.com/s/YOUR_REAL_SPACE
PHOENIX_BASE_URL=https://app.phoenix.arize.com/s/YOUR_REAL_SPACE
PHOENIX_COLLECTOR_ENDPOINT=
PHOENIX_PROJECT=tracepilot-gemini-cli
```

Do not print these values in logs or prompts. `PHOENIX_HOST` is required for
Phoenix MCP. `PHOENIX_BASE_URL` or `PHOENIX_COLLECTOR_ENDPOINT` is required for
OTEL export.

## Local Gates

The root test suite is long, so prefer focused slices while developing:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npx vitest run --coverage=false packages/core/src/telemetry/phoenixSelfIntrospection.test.ts packages/core/src/tracepilot/repairPlanner.test.ts
npx vitest run --coverage=false packages/core/src/policy/shell-safety.test.ts packages/core/src/policy/tracepilot-command-risk.test.ts
npm run test:scripts
```

`npm run build` updates generated git commit files. Restore generated files
before committing unless the change is intentionally part of the build output.

## Phoenix Proof

Run both smoke checks when Phoenix credentials are available:

```bash
npm run smoke:phoenix
npm run smoke:phoenix:mcp
```

Interpretation:

- `smoke:phoenix` proves local span creation and exporter flush.
- `smoke:phoenix:mcp` proves a span is visible and queryable through Phoenix
  MCP.
- Only the MCP smoke proves the TracePilot self-introspection dependency.

## Demo

The demo fixture lives in `examples/broken-node-app`.

```bash
npm run demo:broken-node-app:offline
npm run demo:broken-node-app
```

The offline demo proves the local deterministic path: failing test, safe failure
evidence, repair plan, patch, rerun pass, and sanitized eval report. The strict
demo also requires Phoenix trace visibility and Phoenix MCP queryability.

## Verification Matrix

| Feature                | Command/test                                         | Status                                  | Evidence                                                                                  |
| ---------------------- | ---------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Baseline install       | `npm ci`                                             | Working                                 | Passed in audit baseline.                                                                 |
| Build                  | `npm run build`                                      | Working                                 | Passed during P0/P1 issue verification.                                                   |
| Lint                   | `npm run lint`                                       | Working                                 | Passed during P0/P1 issue verification.                                                   |
| Typecheck              | `npm run typecheck`                                  | Working                                 | Passed during P0/P1 issue verification.                                                   |
| Root tests             | `npm test`                                           | Unverified/long                         | Local audit run exceeded 30 minutes; use focused tests until CI is partitioned.           |
| Phoenix OTEL export    | `npm run smoke:phoenix`                              | Env-dependent                           | Requires `PHOENIX_API_KEY` and collector/base URL.                                        |
| Phoenix MCP visibility | `npm run smoke:phoenix:mcp`                          | Blocked without real Phoenix Cloud host | Requires `PHOENIX_HOST`, project, and exported span visibility.                           |
| Agent/LLM spans        | Core telemetry tests                                 | Working                                 | Span names and OpenInference kinds are covered.                                           |
| Tool spans             | Scheduler/tool tests                                 | Working                                 | Shell, file, MCP, and Phoenix MCP tool spans carry safe metadata.                         |
| Redaction              | Sanitizer/eval/demo tests                            | Working for implemented patterns        | API keys, bearer tokens, private keys, env assignments, and similar secrets are redacted. |
| Command safety         | Policy tests                                         | Working                                 | Blocked/high/medium/low risk classification is covered.                                   |
| Self-introspection     | Phoenix introspection and scheduler tests            | Partial                                 | Failure path attempts Phoenix MCP and attaches evidence or an unavailable reason.         |
| Repair planner         | `packages/core/src/tracepilot/repairPlanner.test.ts` | Working locally                         | Planner consumes structured trace evidence and emits `gemini_cli.chain.repair_plan`.      |
| Evals                  | `npm run test:scripts`                               | Working locally                         | Required deterministic eval IDs produce sanitized JSON.                                   |
| Broken demo            | `npm run demo:broken-node-app:offline`               | Working locally                         | Strict Phoenix-backed demo depends on MCP visibility.                                     |

## Limitations

- TracePilot does not claim real Phoenix MCP self-improvement unless
  `smoke:phoenix:mcp` passes against the target Phoenix project.
- The repair planner is deterministic and evidence-driven; it is not a general
  LLM judge.
- Redaction covers the implemented sensitive patterns, but it is not a complete
  data-loss-prevention product.
- Full root test execution still needs CI partitioning and timeout hardening.
