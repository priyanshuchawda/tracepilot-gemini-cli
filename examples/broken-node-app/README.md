# Broken Node App Demo

This fixture intentionally fails because `src/config.js` defaults `API_BASE_URL`
to localhost. The TracePilot demo runner copies this fixture to a temporary
workspace, observes the failing test, records safe failure evidence, applies the
minimal config repair, reruns the test, and writes TracePilot eval JSON.

Run the local deterministic path:

```bash
npm run demo:broken-node-app:offline
```

Run the strict Phoenix-backed path:

```bash
npm run demo:broken-node-app
```

The offline command allows missing Phoenix credentials and should still prove
the local fail/repair/rerun flow. The strict command requires Phoenix OTEL
export and Phoenix MCP visibility. If `PHOENIX_HOST`, `PHOENIX_API_KEY`, or
`PHOENIX_PROJECT` are missing or placeholder values, the strict command should
fail rather than claiming a real end-to-end trace.
