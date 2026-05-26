# TracePilot

TracePilot is a forked Gemini CLI TypeScript agent runtime with Phoenix
observability, OpenInference-style spans, Phoenix MCP self-introspection, safety
gates, redaction, deterministic evals, and a broken-repo repair demo.

The TypeScript monorepo now lives at the repository root so reviewers can see
the actual project immediately: `package.json`, `packages/`, `docs/`,
`examples/`, `scripts/`, and `.github/` are all top-level.

## What It Proves

TracePilot is built to prove this repair loop:

1. A user asks the agent to fix or debug a broken repo.
2. The agent runs a command.
3. The command fails.
4. The failure is traced to Phoenix.
5. The agent queries Phoenix through MCP.
6. The repair plan references trace evidence.
7. The agent applies the fix.
8. The agent reruns the test.
9. The test passes.
10. A deterministic eval result is logged.

Latest verified Phoenix evidence:

- Phoenix OTEL smoke passed for session `tracepilot-smoke-1778699160858`.
- Phoenix MCP smoke passed for session `tracepilot-mcp-smoke-1778699158476`.
- Strict broken-node demo passed for session
  `tracepilot-broken-node-app-1778699160588`.
- Demo trace evidence: `de13112b1dadd28dda63a83365d92344`.

TracePilot reports now include `proofLevel` and `strictLiveProof`. Treat
`local_offline`, `controlled_substitute`, and `degraded_gemini` as development
evidence only; strict review evidence requires `live_phoenix`,
`live_gemini_phoenix`, or `hosted_cloud_run`.

Cloud Run is intentionally not live right now. The repo contains cheap Cloud Run
deploy and smoke tooling, but a public hosted URL should only be shared after
redeploying and re-running the hosted smoke test.

## Repository Structure

```text
.
|-- README.md                 # GitHub landing page
|-- AGENT.md                  # Operating rules for coding agents
|-- PLAN.md                   # Original TracePilot implementation plan
|-- docs.md                   # Phoenix/OpenInference research notes
|-- .github/                  # Workflows, issue templates, PR template
|-- packages/
|   |-- cli/                  # Gemini CLI terminal package
|   |-- core/                 # Agent runtime, tools, scheduler, telemetry
|   |-- test-utils/           # Shared test helpers
|   `-- vscode-ide-companion/
|-- packages/core/src/
|   |-- telemetry/            # Phoenix OTEL, redaction, spans, MCP query
|   |-- tracepilot/           # Repair planner and deterministic evals
|   |-- policy/               # Command safety and risk classification
|   |-- scheduler/            # Agent turn and tool execution path
|   `-- tools/                # Shell, file, MCP, and related tools
|-- examples/
|   `-- broken-node-app/      # Fail-plan-fix-rerun demo fixture
|-- scripts/                  # Smoke tests, evals, demos, deploy helpers
|-- docs/                     # TracePilot verification and Gemini CLI docs
`-- cloudbuild.tracepilot-cloud-run.yaml
```

## Key Links

- [Verification guide](docs/tracepilot.md)
- [Release and demo checklist](docs/tracepilot-release-demo-checklist.md)
- [Full implementation README snapshot](docs/tracepilot-implementation-readme.md)
- [Broken demo fixture](examples/broken-node-app)
- [Telemetry code](packages/core/src/telemetry)
- [Repair and eval code](packages/core/src/tracepilot)
- [Command safety policy](packages/core/src/policy)

## Quick Start

```bash
npm ci
npm run lint
npm run typecheck
npm run build
```

Focused TracePilot checks:

```bash
npm run ci:tracepilot                 # fast local tier
npm run ci:tracepilot -- --tier=medium
npm run smoke:phoenix
npm run smoke:phoenix:mcp
npm run demo:broken-node-app
npm run smoke:cloud-run:local
```

Use focused checks during development because the full root `npm test` is long.
`ci:tracepilot` writes required, optional, and skipped gate results to
`.ai-logs/tracepilot-ci/summary.json`. Save full logs under ignored `.ai-logs/`
files and share only pass/fail status, exit codes, and short redacted tails on
failure.

## Environment

Copy [`.env.example`](.env.example) and set real values locally:

```bash
GEMINI_API_KEY=...
PHOENIX_API_KEY=...
PHOENIX_HOST=https://app.phoenix.arize.com/s/YOUR_SPACE
PHOENIX_BASE_URL=https://app.phoenix.arize.com/s/YOUR_SPACE
PHOENIX_COLLECTOR_ENDPOINT=
PHOENIX_PROJECT=tracepilot-gemini-cli
```

Never commit `.env` files, API keys, bearer tokens, private keys, or full
command outputs containing secrets. Any credential pasted into chat or
transcripts should be rotated before public submission.

## Current Status

| Area                       | Status                           | Evidence                                                                            |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| Gemini CLI baseline        | Working                          | Build, lint, typecheck slices passed during P0 work.                                |
| Phoenix OTEL export        | Working                          | `npm run smoke:phoenix` passed with real Phoenix config.                            |
| Phoenix MCP visibility     | Working                          | `npm run smoke:phoenix:mcp` returned the smoke trace.                               |
| Phoenix self-introspection | Working                          | Queries Phoenix MCP for matching failed span evidence and degrades when absent.     |
| Broken repo repair demo    | Working                          | Strict demo exported/queryed trace evidence and passed retry tests.                 |
| Redaction                  | Working for implemented patterns | Sanitizer, eval, and demo paths redact secrets before traces/reports.               |
| Command safety gate        | Working                          | Blocks destructive and credential-dumping commands in policy tests.                 |
| Cloud Run hosted URL       | Not currently deployed           | Redeploy later and run `npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"`. |

The repository is private while it is being prepared for final submission.
