# TracePilot Release And Demo Checklist

Use this checklist before recording, submitting, or presenting TracePilot. It is
designed to prevent demo polish from hiding unverified Phoenix integration.

## Judging Video Storyboard

Target a short, evidence-first video. The judges should understand that
TracePilot is useful because it turns an agent repair from "trust the terminal"
into a trace-backed, safety-checked, replayable proof bundle.

Recommended order:

1. Problem statement: show the broken checkout-service or broken-node fixture
   and say the normal agent failure mode is hard to audit after the fact.
2. Failed command: run or show the failed test and point out the session ID that
   will connect terminal output to Phoenix evidence.
3. Phoenix self-introspection: show the Phoenix trace or MCP proof line proving
   the failed tool span was exported, visible, and queried by the agent.
4. Gemini repair: show the changed files count and the small patch summary, not
   a long diff scroll.
5. Safety gate: show the destructive-command block/eval line so reviewers see
   TracePilot is not just optimizing for "make tests pass".
6. Retry proof: show the passing retry command and deterministic eval status.
7. Proof dashboard: open `.ai-logs/tracepilot-dashboard/index.html` and show the
   proof level, strict-live flag, timeline, changed files, judge score/status,
   and safety panel in one screen.
8. Usefulness claim: close with the concrete value: faster repair review,
   auditable Phoenix evidence, safer automation, and judge-ready artifacts.

Avoid spending time on architecture diagrams before the proof. If time remains,
show architecture after the dashboard: Gemini CLI emits spans, Phoenix stores
them, MCP retrieves them, the repair planner uses them, evals and judge
artifacts validate the outcome, and the dashboard makes the evidence readable.

Strict submission footage should use `demo:gemini-repair-agent`,
`demo:phoenix-repair-memory`, and Phoenix MCP proof lines. Offline fallback
footage may show the dashboard and deterministic flow, but it must explicitly
say `strictLiveProof=false` and avoid claiming live Phoenix self-introspection.

## Required Before Strict Demo

- `npm ci` completed on a clean checkout.
- `npm run ci:tracepilot` passes.
- `npm run doctor:tracepilot` reports the expected local readiness state.
- `npm run tracepilot:check` writes a sanitized repair artifact/report for the
  checkout being presented.
- `npm run smoke:cloud-run:local` passes.
- `npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"` passes against the
  actual judging URL.
- `npm run smoke:phoenix` passes with real Phoenix credentials.
- `npm run smoke:phoenix:mcp` passes and reports the smoke span as visible and
  queryable.
- `npm run demo:broken-node-app` passes without `--allow-missing-phoenix`.
- `npm run demo:gemini-repair-agent` passes without `--allow-missing-phoenix`;
  use this command for the agent-repair video.
- The generated demo report contains no raw API keys, bearer tokens,
  authorization headers, private keys, database URLs, or `.env` contents.
- The generated `judge-input.json` and `judge-result.json` contain no raw API
  keys, bearer tokens, authorization headers, private keys, database URLs, or
  `.env` contents.

## Acceptable Offline Demo

Use the offline demo only when the audience understands that Phoenix visibility
is not being proven:

```bash
npm run demo:broken-node-app:offline
```

Offline demo evidence may show:

- initial test failure
- local repair plan
- patched fixture
- passing retry
- sanitized eval JSON
- non-strict judge artifact JSON
- explicit Phoenix unavailable/skipped reason

Offline demo evidence must not claim:

- Phoenix span visibility
- Phoenix MCP query success
- real self-introspection against Phoenix Cloud
- complete MVP end-to-end proof

## Judge Evidence Artifacts

Every demo report should be accompanied by the generated judge artifacts:

- `judge-input.json`
- `judge-result.json`

Without a supplied scored result, `judge-result.json` must say
`mode: "unavailable"` and `strictLiveProof: false`. If an external or live judge
produces a scored result, validate and bundle it with:

```bash
npm run judge:tracepilot -- \
  --repair-artifact .ai-logs/tracepilot-check/repair-artifact.json \
  --eval-report .ai-logs/demo-broken-node-app/result.json \
  --judge-input-output .ai-logs/tracepilot-judge/judge-input.json \
  --judge-result-input .ai-logs/tracepilot-judge/scored-result.json \
  --judge-result-output .ai-logs/tracepilot-judge/judge-result.json
```

The deterministic and Gemini demo commands also accept `--judge-result-input` so
a validated scored result can be bundled directly into their report metadata.
Judge artifacts are repair-quality review evidence; they do not make an offline
or degraded proof strict.

## Video-Ready Gemini Demo Command

This local command does not require Cloud Run or CI/CD. Build the CLI once, then
run Gemini 3 (`gemini-3.1-flash-lite-preview`) against the three-failure
checkout-service fixture:

```powershell
npm run build
npm run demo:gemini-repair-agent -- --env-file C:\path\to\tracepilot-gemini-cli\.env
```

Required proof lines:

- `AGENT_REPAIR: PASS mode=gemini`
- `MODEL_USED: <model> attempts=1`
- `MODEL_FALLBACK: SKIPPED`
- `FAILED_TOOL_SPAN: PASS`
- `PHOENIX_MCP_INTROSPECTION: PASS`
- `CAUSAL_TRACE: PASS`
- `SAFETY_BLOCK: PASS`
- `FILES_CHANGED: PASS count=3`
- `RETRY_TEST: PASS`
- `EVALS: PASS`

Show the printed session ID in Phoenix to demonstrate that Gemini's failed test
run and the Phoenix MCP self-introspection spans belong to the recorded repair.

## Video-Ready Self-Improvement Command

Use this after the single-run command passes. It executes a seed repair and a
replay repair locally; the replay passes only when its
`gemini_cli.chain.repair_memory_retrieve` telemetry references the seed
session's verified repair-report span through Phoenix MCP:

```powershell
npm run demo:phoenix-repair-memory -- --env-file C:\path\to\tracepilot-gemini-cli\.env
```

Required proof lines:

- `SEED_REPAIR: PASS mode=gemini`
- `VERIFIED_REPAIR_RECORDED: PASS`
- `SEED_OUTCOME_VISIBLE: PASS`
- `REPLAY_REPAIR: PASS mode=gemini`
- `PHOENIX_MEMORY_MATCH: PASS`
- `REPLAY_RETRY_TEST: PASS`
- `EVALS: PASS`

Do not use `demo:phoenix-repair-memory:controlled` as submission evidence; it is
a deterministic script-contract test and labels its proof as `SIMULATED`.

## Deterministic Strict Demo Command

Use this only after Phoenix env is configured:

```bash
npm run demo:broken-node-app
```

Expected result:

- first test fails
- failed command span is exported
- Phoenix MCP query returns matching failed span evidence
- repair plan references trace evidence
- patch is applied
- retry test passes
- eval JSON reports all deterministic evals passing

## Hosted Demo Link

The Cloud Run status surface is available as a deployable judging URL, but it is
not currently live. Redeploy it only when you are ready to share a public link:

```bash
npm run secrets:tracepilot-cloud-run -- --dry-run --project priyanshu-portfolio-458519
npm run secrets:tracepilot-cloud-run -- --project priyanshu-portfolio-458519
npm run deploy:tracepilot-cloud-run -- --project priyanshu-portfolio-458519 --region asia-south1 --service tracepilot-url-proof --secret GEMINI_API_KEY=GEMINI_API_KEY --secret PHOENIX_API_KEY=PHOENIX_API_KEY
npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"
```

Current hosted status: not deployed. Re-run the live smoke command after
redeploying and paste only the URL, never secrets, into the final submission
materials.

Latest strict evidence:

- Cloud Run Secret Manager sync: passed.
- Cloud Run live smoke: previously passed, but the service has since been
  removed; redeploy and verify again before judging.
- Phoenix OTEL smoke: passed for session `tracepilot-smoke-1778699160858`.
- Phoenix MCP smoke: passed for session `tracepilot-mcp-smoke-1778699158476`.
- Strict broken-node demo: passed for session
  `tracepilot-broken-node-app-1778699160588`.
- Strict demo trace evidence: `de13112b1dadd28dda63a83365d92344`.
- Live Gemini 3.5 repair demo: passed for session
  `tracepilot-gemini-repair-1779628389727`; Phoenix MCP introspection,
  three-file repair, retry tests, and eval gates passed.
- Self-introspection regression coverage: matching failed spans are preferred,
  and empty Phoenix span responses degrade without claiming trace evidence.

For cheap default operation, the deploy helper configures min instances as zero
and max instances as one. The hosted service exposes only fixed demo/status
endpoints and never returns raw secret values. Keep
`TRACEPILOT_ENABLE_DEMO_RUNS=false` for the public judging link unless you are
running a controlled live demo.

Before sharing the link, verify:

- `/api/health` returns `ok: true`
- `/api/status` returns env presence booleans only
- `/api/demo` reports the deterministic repair path
- the smoke output contains no API key, bearer token, private key, or `.env`
  content

## Sanitized Transcript Rules

Store terminal transcripts under `.ai-logs/` or another ignored path. Before
sharing a transcript, verify that it contains:

- command names and exit codes
- final pass/fail status
- short redacted output previews
- output hashes where available
- Phoenix project/session identifiers only when they are not secrets

Verify that it does not contain:

- raw `.env` contents
- `GEMINI_API_KEY`
- `PHOENIX_API_KEY`
- bearer tokens
- authorization headers
- private keys
- full command output with credentials

## Screenshots

Do not add Phoenix UI screenshots until `npm run smoke:phoenix:mcp` passes for
the same Phoenix project used in the demo. When screenshots are added, crop or
redact any tenant, account, token, or unrelated trace data.

## Current Blocker

Strict Phoenix proof is available from the recorded smoke/demo sessions above.
The current blocker for a public hosted URL is only Cloud Run redeployment. When
you are ready to share a live link, rotate any credentials that were pasted into
chat or transcripts, sync them to Secret Manager, deploy, and run:

```bash
npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"
```

Do not claim hosted readiness until that smoke passes against the new live URL.
