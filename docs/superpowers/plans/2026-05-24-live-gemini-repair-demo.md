# Live Gemini Repair Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a video-ready local demo where the actual Gemini CLI running
Gemini 3 repairs a richer broken project and the report proves Phoenix MCP
self-introspection with concise output.

**Architecture:** A new demo runner copies a three-defect Node fixture into a
disposable workspace, starts Gemini CLI headlessly with a known session ID, and
independently verifies the repaired tests and changed files. In strict mode it
queries Phoenix through `@arizeai/phoenix-mcp` for that session's failed shell
and self-introspection spans; in offline test mode it runs a controlled
substitute agent and explicitly reports degraded Phoenix evidence.

**Tech Stack:** TypeScript/`tsx`, Node test runner, Vitest script tests, Gemini
CLI headless `stream-json`, Phoenix OTEL/MCP, existing TracePilot eval helpers.

---

### Task 1: Rich Broken Service Fixture

**Files:**

- Create: `examples/broken-checkout-service/package.json`
- Create: `examples/broken-checkout-service/src/config.js`
- Create: `examples/broken-checkout-service/src/signature.js`
- Create: `examples/broken-checkout-service/src/redact.js`
- Create: `examples/broken-checkout-service/test/checkout.test.js`
- Create: `examples/broken-checkout-service/README.md`

- [ ] **Step 1: Define tests that demonstrate three production defects**

```js
test('uses the production payments endpoint', () => {
  assert.equal(getPaymentBaseUrl({}), 'https://payments.example.test');
});
test('accepts a correctly signed payment webhook', () => {
  assert.equal(verifyWebhookSignature(payload, validSignature, secret), true);
});
test('redacts bearer credentials from diagnostic output', () => {
  assert.equal(
    redactDiagnostic('Authorization: Bearer videoSecretToken'),
    'Authorization: Bearer [REDACTED]',
  );
});
```

- [ ] **Step 2: Keep intentionally broken implementations in the fixture**

```js
export function getPaymentBaseUrl(env = {}) {
  return env.PAYMENTS_BASE_URL ?? 'http://localhost:8787';
}
export function verifyWebhookSignature() {
  return false;
}
export function redactDiagnostic(value) {
  return value;
}
```

- [ ] **Step 3: Run the fixture test and confirm it fails**

Run: `node --test examples/broken-checkout-service/test/checkout.test.js`

Expected: `FAIL` with three failing assertions before Gemini repairs the copied
workspace.

### Task 2: Demo Runner Contract Test

**Files:**

- Modify: `scripts/tests/strong-agent-repair-demo.test.ts`
- Create: `scripts/testing/fake-checkout-repair-agent.mjs`
- Create: `scripts/demo-gemini-repair-agent.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing orchestration test**

```ts
expect(stdout).toContain('AGENT_REPAIR: PASS');
expect(stdout).toContain('PHOENIX_MCP_INTROSPECTION: DEGRADED');
expect(stdout).toContain('FILES_CHANGED: PASS count=3');
expect(stdout).toContain('RETRY_TEST: PASS');
expect(report.agent.mode).toBe('substitute');
expect(JSON.stringify(report)).not.toContain('videoSecretToken');
```

- [ ] **Step 2: Run it red before implementation**

Run:
`npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/strong-agent-repair-demo.test.ts --reporter=dot`

Expected: `FAIL` because `scripts/demo-gemini-repair-agent.ts` does not exist.

- [ ] **Step 3: Add a controlled substitute agent for deterministic tests**

```js
await writeFile(path.join(workspace, 'src/config.js'), repairedConfig);
await writeFile(path.join(workspace, 'src/signature.js'), repairedSignature);
await writeFile(path.join(workspace, 'src/redact.js'), repairedRedactor);
console.log(
  JSON.stringify({ type: 'result', status: 'success', mode: 'substitute' }),
);
```

- [ ] **Step 4: Implement the runner with real Gemini as its default agent**

```ts
const agentArgs = options.agentScript
  ? [path.resolve(options.agentScript), demoDir]
  : [
      cliPath,
      '--prompt',
      prompt,
      '--session-id',
      sessionId,
      '--approval-mode=yolo',
      '--sandbox=false',
      '--skip-trust',
      '--model',
      'gemini-3.5-flash',
      '--output-format',
      'stream-json',
    ];
const agent = await runAgent(agentArgs, demoDir);
const retry = await runNodeTests(demoDir);
const spans = await queryPhoenixSession(sessionId);
printProofLines(report);
```

- [ ] **Step 5: Add runnable scripts**

```json
"demo:gemini-repair-agent": "tsx scripts/demo-gemini-repair-agent.ts",
"demo:gemini-repair-agent:offline": "tsx scripts/demo-gemini-repair-agent.ts --allow-missing-phoenix --agent-script scripts/testing/fake-checkout-repair-agent.mjs"
```

- [ ] **Step 6: Run it green**

Run:
`npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/strong-agent-repair-demo.test.ts --reporter=dot`

Expected: `PASS` with one passing test.

### Task 3: Strict Phoenix and Actual Gemini Proof

**Files:**

- Modify: `docs/tracepilot.md`
- Modify: `docs/tracepilot-release-demo-checklist.md`

- [ ] **Step 1: Document the local video command and proof lines**

```bash
npm run build
npm run demo:gemini-repair-agent -- --env-file C:\path\to\.env
```

Expected proof lines include `AGENT_REPAIR: PASS`, `FAILED_TOOL_SPAN: PASS`,
`PHOENIX_MCP_INTROSPECTION: PASS`, `FILES_CHANGED: PASS count=3`,
`RETRY_TEST: PASS`, and `EVALS: PASS`.

- [ ] **Step 2: Run focused static and deterministic checks**

Run:
`npx prettier --check scripts/demo-gemini-repair-agent.ts scripts/testing/fake-checkout-repair-agent.mjs scripts/tests/strong-agent-repair-demo.test.ts examples/broken-checkout-service docs/tracepilot.md docs/tracepilot-release-demo-checklist.md package.json`

Expected: `PASS`.

Run: `npm run demo:gemini-repair-agent:offline`

Expected: local repair proof passes and Phoenix status is explicitly `DEGRADED`.

- [ ] **Step 3: Build CLI and run real strict demonstration**

Run: `npm run build`

Expected: `PASS` and `packages/cli/dist/index.js` exists.

Run:
`npm run demo:gemini-repair-agent -- --env-file C:\Users\Admin\Desktop\tracepilot-gemini-cli\.env`

Expected: Gemini changes exactly the three intended files, retry tests pass,
failed shell span and Phoenix MCP self-introspection spans are visible for the
supplied session ID, and TracePilot evals pass.

- [ ] **Step 4: Commit and publish issue #88**

```bash
git add package.json scripts examples docs
git commit -m "feat(tracepilot): add live Gemini repair proof"
git push -u origin feat/88-strong-local-agent-demo
gh pr create --title "feat: add live Gemini repair proof" --body "Closes #88"
```

Expected: PR links to issue `#88`; after review/verification it is merged and
the feature branch is deleted.
