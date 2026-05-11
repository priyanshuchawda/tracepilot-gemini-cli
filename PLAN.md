# TracePilot: Self-Improving Gemini CLI Agent with Arize Phoenix Observability

## Project Overview

A forked **Gemini CLI TypeScript agent runtime** instrumented with **Arize Phoenix** observability. The agent can observe itself, debug itself, and improve itself using its own trace data.

> **Core Claim:** TracePilot uses Arize Phoenix not only for observability, but as runtime memory for self-debugging and self-improvement.

---

## Architecture

```
User Request
    |
Forked Gemini CLI (TypeScript)
    |
TracePilot Session Manager
    |
Pre-command Safety Gate (LLM policy check)
    |
Gemini Reasoning Call --> OpenInference LLM Span
    |
Tool Planner --> OpenInference Chain Span
    |
Tool Execution Wrapper
    |-- Shell Command   --> tool.shell span
    |-- File Operation  --> tool.file span
    |-- MCP Tool        --> tool.mcp span
    +-- Phoenix MCP     --> tool.phoenix_mcp span
    |
All spans --> Phoenix Cloud (via @arizeai/phoenix-otel)
    |
Phoenix MCP Server (npx @arizeai/phoenix-mcp@latest)
    |
Agent Self-Inspection --> chain.self_introspection span
    |
Repair / Retry / Evaluate / Improve
```

**Core Loop:** `observe -> act -> trace -> inspect trace -> evaluate -> improve next action`

---

## Research Summary (Context7 Docs)

### 1. Gemini CLI -- MCP Server Configuration

Source: `/google-gemini/gemini-cli` docs

Gemini CLI supports MCP servers via `settings.json`:

```json
{
  "mcpServers": {
    "serverName": {
      "command": "path/to/server",
      "args": ["--arg1", "value1"],
      "env": { "API_KEY": "$MY_API_TOKEN" },
      "cwd": "./server-directory",
      "timeout": 30000,
      "trust": false
    }
  }
}
```

**Existing telemetry infrastructure** in the fork:
- `packages/core/src/telemetry/sdk.ts` -- Full OpenTelemetry NodeSDK setup with `BatchSpanProcessor`, OTLP exporters (gRPC + HTTP), file exporters
- `packages/core/src/telemetry/trace.ts` -- `runInDevTraceSpan()` wrapper with `GeminiCliOperation` enum (`ToolCall`, `LLMCall`, `UserPrompt`, `SystemPrompt`, `AgentCall`, `ScheduleToolCalls`)
- `packages/core/src/telemetry/constants.ts` -- GenAI semantic conventions already defined
- `packages/core/src/telemetry/config.ts` -- Supports `otlpEndpoint` (gRPC/HTTP), `target`, `logPrompts`, `outfile`

**Critical insight:** Gemini CLI already has OpenTelemetry baked in. We can **extend** the existing telemetry SDK to also export to Phoenix, rather than building from scratch.

The `settings.json` supports:
```json
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "otlpEndpoint": "http://localhost:4317",
    "logPrompts": true
  }
}
```

### 2. Arize Phoenix -- TypeScript SDK and MCP Server

Source: `/websites/arize_phoenix` docs

**Phoenix OTel registration (TypeScript):**
```typescript
import { register } from "@arizeai/phoenix-otel";
register(); // reads PHOENIX_COLLECTOR_ENDPOINT, PHOENIX_API_KEY env vars
```

**Phoenix MCP Server config:**
```json
{
  "mcpServers": {
    "phoenix": {
      "command": "npx",
      "args": ["-y", "@arizeai/phoenix-mcp@latest", "--baseUrl", "https://app.phoenix.arize.com/s/YOUR_SPACE", "--apiKey", "YOUR_KEY"],
      "timeout": 30000,
      "trust": false
    }
  }
}
```

**MCP Instrumentation (TypeScript):**
```typescript
import { register } from "@arizeai/phoenix-otel";
import { MCPInstrumentation } from "@arizeai/openinference-instrumentation-mcp";
const tracerProvider = register({ projectName: "mcp-app" });
const instrumentation = new MCPInstrumentation();
instrumentation.enable();
```

Phoenix MCP Server provides access to: projects, traces, spans, sessions, prompts, datasets, experiments, annotations, eval results.

### 3. OpenInference -- Semantic Conventions and Helpers

Source: `/arize-ai/openinference` docs

**LLM Attribute Helpers:**
```typescript
import { trace } from "@opentelemetry/api";
import { getLLMAttributes } from "@arizeai/openinference-core";

const tracer = trace.getTracer("llm-service");
tracer.startActiveSpan("llm-inference", (span) => {
  span.setAttributes(getLLMAttributes({
    provider: "google",
    modelName: "gemini-2.5-pro",
    inputMessages: [{ role: "user", content: "..." }],
    outputMessages: [{ role: "assistant", content: "..." }],
    tokenCount: { prompt: 12, completion: 44, total: 56 },
    invocationParameters: { temperature: 0.2 },
  }));
  span.end();
});
```

**Convenience Wrappers:**
```typescript
import { traceAgent, traceChain, traceTool } from "@arizeai/openinference-core";

const chain = traceChain(myPipeline, { name: "rag-chain" });     // kind = CHAIN
const agent = traceAgent(myOrchestrator, { name: "qa-agent" });   // kind = AGENT
const tool  = traceTool(myApiCall, { name: "weather-lookup" });    // kind = TOOL
```

---

## Gemini CLI Fork -- Instrumentation Points

Based on source code analysis of the fork at `c:\Users\Admin\Desktop\arize\gemini-cli`:

| File | What to Instrument | Span Name |
|---|---|---|
| `packages/core/src/agent/agent-session.ts` | `send()` / `sendStream()` | `gemini_cli.agent_turn` |
| `packages/core/src/telemetry/trace.ts` | `runInDevTraceSpan()` | Extend with OpenInference attrs |
| `packages/core/src/tools/shell.ts` | `ShellToolInvocation.execute()` | `gemini_cli.tool.shell` |
| `packages/core/src/tools/mcp-tool.ts` | MCP tool execution | `gemini_cli.tool.mcp` |
| `packages/core/src/tools/tools.ts` | Base tool execution | `gemini_cli.tool.*` |
| `packages/core/src/tools/write-file.ts` | File write operations | `gemini_cli.tool.file` |
| `packages/core/src/tools/read-file.ts` | File read operations | `gemini_cli.tool.file` |
| `packages/core/src/telemetry/sdk.ts` | `initializeTelemetry()` | Phoenix dual-export |

**Key discovery:** The existing `telemetry/sdk.ts` already supports OTLP HTTP export. We can configure `otlpEndpoint` to point at Phoenix Cloud's `/v1/traces` endpoint, getting traces into Phoenix with **zero new dependencies** for basic tracing. Then we layer OpenInference semantic attributes on top.

---

## Project Structure

```
tracepilot-gemini-cli/
  packages/
    cli/                          # Forked Gemini CLI
    core/                         # Forked core (agent, tools, telemetry)
      src/
        telemetry/
          sdk.ts                  # MODIFIED: Add Phoenix OTLP exporter
          trace.ts                # MODIFIED: Add OpenInference attributes
          phoenix-bridge.ts       # NEW: Phoenix registration + config
          constants.ts            # MODIFIED: Add TracePilot span names
        tools/
          shell.ts                # MODIFIED: Add traced shell wrapper
          mcp-tool.ts             # MODIFIED: Add traced MCP wrapper
        tracepilot/               # NEW: TracePilot-specific modules
          self-introspection.ts
          repair-planner.ts
          command-safety-gate.ts
          redaction.ts
          eval-runner.ts
    observability/                # NEW: OpenInference tracing wrappers
      src/
        registerPhoenix.ts
        traceAgentTurn.ts
        traceLLMCall.ts
        traceToolCall.ts
        traceShellCommand.ts
        traceMCPCall.ts
        redaction.ts
        session.ts
      package.json
    evals/                        # NEW: Evaluation pipeline
      src/
        code-evals.ts
        llm-judge-evals.ts
        eval-runner.ts
      package.json
  examples/
    broken-node-app/              # Demo: broken tests scenario
    broken-python-app/            # Demo: broken Python project
    deployment-debug-demo/        # Demo: deployment debugging
  docs/
    ARCHITECTURE.md
    ARIZE_SETUP.md
    DEMO_SCRIPT.md
  .env.example
  LICENSE                         # Apache-2.0
  PLAN.md                        # This file
  README.md
```

---

## Span Taxonomy

| Span Name | Kind | When |
|---|---|---|
| `gemini_cli.agent_turn` | AGENT | Every user request |
| `gemini_cli.llm.generate` | LLM | Every Gemini API call |
| `gemini_cli.chain.plan` | CHAIN | Agent planning step |
| `gemini_cli.chain.pre_command_check` | CHAIN | Pre-command safety gate |
| `gemini_cli.tool.shell` | TOOL | Shell command execution |
| `gemini_cli.tool.file` | TOOL | File read/write |
| `gemini_cli.tool.mcp` | TOOL | MCP tool call |
| `gemini_cli.tool.phoenix_mcp` | TOOL | Phoenix MCP introspection |
| `gemini_cli.chain.self_introspection` | CHAIN | Trace self-inspection |
| `gemini_cli.chain.repair_plan` | CHAIN | Repair planning |
| `gemini_cli.eval.run` | CHAIN | Evaluation execution |

---

## Phase Plan

### Phase 0 -- Repository Setup (Day 1, Part 1)
- [x] Fork Gemini CLI locally
- [ ] Create private GitHub repo `tracepilot-gemini-cli`
- [ ] Initialize git, push fork
- [ ] Add `.env.example`, `LICENSE` (Apache-2.0), `README.md`

### Phase 1 -- Gemini CLI Baseline (Day 1, Part 2)
- [ ] Install dependencies (`npm ci`)
- [ ] Build and run locally (`npm run build && npm start`)
- [ ] Confirm Gemini API auth works
- [ ] Confirm ShellTool, file tools, MCP loading works
- [ ] Add wrapper logs around key hook points
- [ ] Add custom command: `/tracepilot status`

### Phase 2 -- Phoenix Cloud Setup (Day 2, Part 1)
- [ ] Create Phoenix Cloud account
- [ ] Set environment variables
- [ ] Create `packages/observability/src/registerPhoenix.ts`
- [ ] Strategy A (preferred): Extend existing `telemetry/sdk.ts` to add Phoenix as secondary OTLP HTTP exporter
- [ ] Strategy B (fallback): Use `@arizeai/phoenix-otel` `register()` at CLI entrypoint

### Phase 3 -- OpenInference Tracing Layer (Day 2-3)

**NPM packages to install:**
```bash
npm install @arizeai/phoenix-otel @arizeai/openinference-core @arizeai/openinference-semantic-conventions @arizeai/openinference-instrumentation-mcp
```

**Tracing wrappers to create:**
1. Agent Turn -- Wrap `AgentSession.send()` with root AGENT span
2. LLM Call -- Extend existing `runInDevTraceSpan(GeminiCliOperation.LLMCall)` with `getLLMAttributes()`
3. Shell Command -- Wrap `ShellToolInvocation.execute()` with TOOL span
4. MCP Tool -- Wrap MCP tool execution with TOOL span
5. Planning -- Add CHAIN span around planning logic
6. Pre-command Gate -- New CHAIN span for safety classification

### Phase 4 -- Redaction Layer (Day 3)
- [ ] Create `packages/observability/src/redaction.ts`
- [ ] Patterns: `AIza...`, `sk-...`, `ghp_...`, `Bearer ...`, `-----BEGIN PRIVATE KEY-----`, `password=`, `api_key=`, `DATABASE_URL=`
- [ ] For command output: store first/last 4000 chars + hash of full output
- [ ] Never send raw `.env` files to Phoenix

### Phase 5 -- Phoenix MCP Integration (Day 3-4)
- [ ] Add Phoenix MCP to `settings.json`
- [ ] Verify agent can call Phoenix MCP tools at runtime
- [ ] Test querying: projects, traces, spans, sessions

### Phase 6 -- Self-Improvement Loop (Day 4)

**Trigger conditions:**
- Command exits non-zero
- Same command fails twice
- Test/build failure detected
- User says "that didn't work"

**Loop:**
1. Failure happens, traced to Phoenix
2. Agent calls Phoenix MCP: "Find latest failed spans for current session"
3. Agent analyzes: stderr, previous plan, similar past failures
4. Agent generates repair plan (traced as `chain.repair_plan`)
5. Agent executes safer next command
6. New result traced, agent compares before/after

### Phase 7 -- Evaluations (Day 5)

**Code evals (deterministic):**

| Eval | Check |
|---|---|
| `command_success` | Exit code 0? |
| `test_passed` | Tests pass? |
| `blocked_destructive_command` | Dangerous command blocked? |
| `secret_redaction_success` | Secrets redacted? |
| `phoenix_trace_created` | Trace sent to Phoenix? |
| `self_introspection_triggered` | Agent inspected traces after failure? |
| `repair_attempt_successful` | Repair fixed the issue? |

**LLM-as-judge evals:**
- Was the plan reasonable?
- Was the command safe?
- Did the agent use trace evidence from Phoenix?
- Did the repair address the actual failure?

### Phase 8 -- Demo Scenario (Day 5-6)

**Broken repo:** `examples/broken-node-app/`
**Bug:** Test fails because env var `API_BASE_URL` is missing.

**Demo flow (3 minutes):**
1. 0:00-0:20 -- Problem statement
2. 0:20-0:45 -- Introduce TracePilot
3. 0:45-1:30 -- Agent runs tests, fails, Phoenix trace created
4. 1:30-2:10 -- Agent calls Phoenix MCP, finds root cause, generates repair plan
5. 2:10-2:40 -- Agent patches config, tests pass
6. 2:40-3:00 -- Show eval results in Phoenix dashboard

---

## Command Safety Model

| Risk Level | Examples | Action |
|---|---|---|
| LOW | `ls`, `cat`, `grep`, `pwd` | Auto-allow |
| MEDIUM | `npm install`, `pytest`, `npm test`, file writes | Allow with trace |
| HIGH | `rm`, `chmod`, `deploy`, `git push` | Require confirmation |
| BLOCKED | `rm -rf /`, `cat .env`, `printenv`, credential dump | Block always |

---

## Environment Variables

```bash
# Required
GEMINI_API_KEY=                     # Gemini API key
PHOENIX_API_KEY=                    # Phoenix Cloud API key
PHOENIX_BASE_URL=https://app.phoenix.arize.com/s/YOUR_SPACE

# Optional
PHOENIX_COLLECTOR_ENDPOINT=         # Defaults to {BASE_URL}/v1/traces
PHOENIX_PROJECT=tracepilot-gemini-cli
```

---

## NPM Dependencies to Add

```json
{
  "@arizeai/phoenix-otel": "latest",
  "@arizeai/openinference-core": "latest",
  "@arizeai/openinference-semantic-conventions": "latest",
  "@arizeai/openinference-instrumentation-mcp": "latest"
}
```

Phoenix MCP runs via `npx` (no permanent install needed).

---

## Build Schedule

| Day | Focus |
|---|---|
| Day 1 | Fork setup, repo creation, baseline CLI working |
| Day 2 | Phoenix Cloud setup, OpenInference tracing layer |
| Day 3 | Redaction, Phoenix MCP integration, first traces visible |
| Day 4 | Self-improvement loop, command safety gate |
| Day 5 | Evals, broken demo repo, repeatable scenario |
| Day 6 | README polish, screenshots, 3-min demo video, Devpost |

---

## MVP Definition

The MVP is complete when this works end-to-end:

1. User asks agent to fix a broken repo
2. Agent runs a command
3. Command fails
4. Failure is visible in Phoenix
5. Agent queries Phoenix through MCP
6. Agent uses trace details to create repair plan
7. Agent applies fix
8. Agent reruns test and it passes
9. Eval is logged

---

## Winning Angle (Arize Track)

| Criteria | Our Answer |
|---|---|
| Technical Implementation | Forked Gemini CLI TypeScript runtime, manual OpenInference tracing, Phoenix Cloud export, Phoenix MCP integration, command/tool wrappers, eval pipeline, redaction layer |
| Meaningful Tracing | Not just LLM spans: planning, command risk checks, shell execution, MCP calls, failures, repairs, evals |
| Meaningful MCP | Phoenix MCP used by agent at runtime to inspect its own operational data; directly changes next action |
| Self-Improvement | Failure then trace then Phoenix MCP lookup then repair plan then retry then eval |
| Impact | Safer coding/deployment agents, better debugging, useful for teams adopting AI agents |
