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

Do not print these values in logs or prompts. Phoenix MCP needs a real Phoenix
base URL; the smoke/demo scripts resolve it from `PHOENIX_HOST`,
`PHOENIX_BASE_URL`, or a Phoenix Cloud-style `PHOENIX_COLLECTOR_ENDPOINT`.
`PHOENIX_BASE_URL` or `PHOENIX_COLLECTOR_ENDPOINT` is required for OTEL export.

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
demo also requires Phoenix trace visibility and Phoenix MCP queryability. Use
the [release and demo checklist](tracepilot-release-demo-checklist.md) before
recording or submitting demo evidence.

## Hosted Cloud Run Demo

TracePilot includes a small Cloud Run-compatible status surface for judging and
demo proof. It is intentionally not a general remote shell. The public endpoints
are fixed:

- `GET /healthz`
- `GET /api/health`
- `GET /api/status`
- `GET /api/demo`
- `POST /api/demo/run`

`/api/status` returns only presence booleans for sensitive environment
variables. It must not return API key, bearer token, authorization header, or
`.env` values.

Run the local Cloud Run smoke first:

```bash
npm run smoke:cloud-run:local
```

If you have rotated Gemini/Phoenix credentials in local `.env` or process env,
sync them to Secret Manager without printing values:

```bash
npm run secrets:tracepilot-cloud-run -- --dry-run --project priyanshu-portfolio-458519
npm run secrets:tracepilot-cloud-run -- --project priyanshu-portfolio-458519
```

Deploy cheaply to the configured Google Cloud project with min instances set to
zero and max instances set to one:

```bash
gcloud config set project priyanshu-portfolio-458519
npm run deploy:tracepilot-cloud-run -- --project priyanshu-portfolio-458519 --region asia-south1 --service tracepilot-url-proof --secret GEMINI_API_KEY=GEMINI_API_KEY --secret PHOENIX_API_KEY=PHOENIX_API_KEY
```

Current hosted status: not deployed. The earlier Cloud Run proof was removed to
avoid carrying a live service before final submission. Redeploy with the command
above and re-run the live smoke before sharing a public judging URL.

If you want the hosted service to run the deterministic repair demo, redeploy
with `--enable-demo-runs`. Keep it disabled for public judging links unless you
need the live endpoint to execute the repair path during a controlled demo.

After deployment, verify the live URL:

```bash
npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"
```

The deployed smoke proves the hosted link responds and does not leak secret-like
values. It does not prove Phoenix span visibility; run
`npm run smoke:phoenix:mcp` and `npm run demo:broken-node-app` separately for
strict Phoenix proof.

If `npm run secrets:tracepilot-cloud-run -- --dry-run` reports missing
`GEMINI_API_KEY` or `PHOENIX_API_KEY`, put rotated values in local `.env` first.
Do not paste keys into issue comments, PR descriptions, or terminal logs.

## Verification Matrix

| Feature                | Command/test                                                | Status                           | Evidence                                                                                                       |
| ---------------------- | ----------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Baseline install       | `npm ci`                                                    | Working                          | Passed in audit baseline.                                                                                      |
| Build                  | `npm run build`                                             | Working                          | Passed during P0/P1 issue verification.                                                                        |
| Lint                   | `npm run lint`                                              | Working                          | Passed during P0/P1 issue verification.                                                                        |
| Typecheck              | `npm run typecheck`                                         | Working                          | Passed during P0/P1 issue verification.                                                                        |
| Root tests             | `npm test`                                                  | Unverified/long                  | Local audit run exceeded 30 minutes; use focused tests until CI is partitioned.                                |
| Phoenix OTEL export    | `npm run smoke:phoenix`                                     | Env-dependent                    | Requires `PHOENIX_API_KEY` and collector/base URL.                                                             |
| Phoenix MCP visibility | `npm run smoke:phoenix:mcp`                                 | Working                          | Passed for session `tracepilot-mcp-smoke-1778699158476`; Phoenix MCP returned span `gemini_cli.agent_turn`.    |
| Agent/LLM spans        | Core telemetry tests                                        | Working                          | Span names and OpenInference kinds are covered.                                                                |
| Tool spans             | Scheduler/tool tests                                        | Working                          | Shell, file, MCP, and Phoenix MCP tool spans carry safe metadata.                                              |
| Redaction              | Sanitizer/eval/demo tests                                   | Working for implemented patterns | API keys, bearer tokens, private keys, env assignments, and similar secrets are redacted.                      |
| Command safety         | Policy tests                                                | Working                          | Blocked/high/medium/low risk classification is covered.                                                        |
| Self-introspection     | Phoenix introspection, scheduler tests, and strict demo     | Working                          | Failure path queries Phoenix MCP, selects matching failed span evidence, and degrades when evidence is absent. |
| Repair planner         | `packages/core/src/tracepilot/repairPlanner.test.ts`        | Working locally                  | Planner consumes structured trace evidence and emits `gemini_cli.chain.repair_plan`.                           |
| Evals                  | `npm run test:scripts`                                      | Working locally                  | Required deterministic eval IDs produce sanitized JSON.                                                        |
| Broken demo            | `npm run demo:broken-node-app`                              | Working                          | Strict demo passed with Phoenix-visible trace `de13112b1dadd28dda63a83365d92344` and all deterministic evals.  |
| Cloud Run local smoke  | `npm run smoke:cloud-run:local`                             | Working locally                  | Verifies health/status/demo endpoints without requiring Phoenix secrets.                                       |
| Cloud Run live smoke   | `npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"` | Not currently deployed           | User intentionally removed Cloud Run for now; redeploy and re-run smoke before sharing a URL.                  |

## Latest Strict Proof

The latest strict proof run used local `.env` values loaded outside Git and did
not print raw secret values:

- `npm run secrets:tracepilot-cloud-run -- --dry-run --project priyanshu-portfolio-458519`:
  passed.
- `npm run secrets:tracepilot-cloud-run -- --project priyanshu-portfolio-458519`:
  passed and synced `GEMINI_API_KEY` plus `PHOENIX_API_KEY` to Secret Manager.
- `npm run smoke:phoenix`: passed for session `tracepilot-smoke-1778699160858`.
- `npm run smoke:phoenix:mcp`: passed for session
  `tracepilot-mcp-smoke-1778699158476`; Phoenix MCP found trace
  `f3e4acf2ed12c206429ff4b82fbe0d00`.
- `npm run demo:broken-node-app`: passed for session
  `tracepilot-broken-node-app-1778699160588`; Phoenix evidence trace
  `de13112b1dadd28dda63a83365d92344`, retry test passed, and all deterministic
  evals passed.

Treat any credentials pasted into chat or shared transcripts as compromised and
rotate them before final public submission.

## Limitations

- TracePilot claims real Phoenix MCP self-introspection only for runs where
  `smoke:phoenix:mcp` or the strict demo passes against the target Phoenix
  project.
- TracePilot does not claim hosted demo readiness unless
  `npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"` passes against the
  live Cloud Run URL.
- The repair planner is deterministic and evidence-driven; it is not a general
  LLM judge.
- Redaction covers the implemented sensitive patterns, but it is not a complete
  data-loss-prevention product.
- Full root test execution still needs CI partitioning and timeout hardening.
