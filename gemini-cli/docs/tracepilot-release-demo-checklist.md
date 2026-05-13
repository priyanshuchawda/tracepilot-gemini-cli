# TracePilot Release And Demo Checklist

Use this checklist before recording, submitting, or presenting TracePilot. It is
designed to prevent demo polish from hiding unverified Phoenix integration.

## Required Before Strict Demo

- `npm ci` completed on a clean checkout.
- `npm run ci:tracepilot` passes.
- `npm run smoke:cloud-run:local` passes.
- `npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"` passes against the
  actual judging URL.
- `npm run smoke:phoenix` passes with real Phoenix credentials.
- `npm run smoke:phoenix:mcp` passes and reports the smoke span as visible and
  queryable.
- `npm run demo:broken-node-app` passes without `--allow-missing-phoenix`.
- The generated demo report contains no raw API keys, bearer tokens,
  authorization headers, private keys, database URLs, or `.env` contents.

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
- explicit Phoenix unavailable/skipped reason

Offline demo evidence must not claim:

- Phoenix span visibility
- Phoenix MCP query success
- real self-introspection against Phoenix Cloud
- complete MVP end-to-end proof

## Strict Demo Command

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

Use the Cloud Run status surface as the stable hosted project URL:

```bash
npm run deploy:tracepilot-cloud-run -- --project priyanshu-portfolio-458519 --region asia-south1 --service tracepilot-url-proof
npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"
```

Current verified Cloud Run URL:

```text
https://tracepilot-url-proof-1051094454693.asia-south1.run.app
```

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

Strict end-to-end demo proof is blocked until real Phoenix environment values
are available:

```bash
PHOENIX_API_KEY=...
PHOENIX_HOST=https://app.phoenix.arize.com/s/YOUR_REAL_SPACE
PHOENIX_BASE_URL=https://app.phoenix.arize.com/s/YOUR_REAL_SPACE
PHOENIX_PROJECT=tracepilot-gemini-cli
npm run smoke:phoenix:mcp
```

If `PHOENIX_HOST` is not set, the smoke/demo scripts can derive the Phoenix MCP
host from `PHOENIX_BASE_URL` or from a Phoenix Cloud-style
`PHOENIX_COLLECTOR_ENDPOINT`.
