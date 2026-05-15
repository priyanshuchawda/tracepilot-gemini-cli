# TracePilot Gemini CLI

TracePilot is a Gemini CLI fork that turns agent debugging into an observable
repair loop. It keeps the Gemini CLI agent runtime, then adds Phoenix
OpenTelemetry tracing, OpenInference-oriented spans, Phoenix MCP
self-introspection, redaction, deterministic evals, command safety gates, and a
broken-repo repair demo that proves the loop end to end.

Cloud deployment note: this repo includes a cheap Cloud Run status/demo surface
and Secret Manager deploy helpers, but no live Cloud Run URL is claimed in the
README right now. Redeploy and re-run the hosted smoke before using a public
judging link.

## What TracePilot Proves

The strict verified flow is:

1. A broken Node repo test fails.
2. The failed command is traced as `gemini_cli.tool.shell`.
3. The failure span is exported to Phoenix.
4. TracePilot queries Phoenix through Phoenix MCP.
5. The repair plan references Phoenix trace evidence.
6. TracePilot applies the deterministic fix.
7. The test reruns and passes.
8. Deterministic eval JSON records command success, test pass, safety,
   redaction, Phoenix trace creation, self-introspection, and repair success.

Latest strict local/Phoenix evidence:

- Phoenix OTEL smoke passed for session `tracepilot-smoke-1778699160858`.
- Phoenix MCP smoke passed for session `tracepilot-mcp-smoke-1778699158476` and
  trace `f3e4acf2ed12c206429ff4b82fbe0d00`.
- Strict broken-node demo passed for session
  `tracepilot-broken-node-app-1778699160588` and trace
  `de13112b1dadd28dda63a83365d92344`.

## Architecture Map

- CLI/agent runtime: upstream Gemini CLI packages under `packages/cli` and
  `packages/core`.
- Agent turn and scheduler path: `packages/core/src/scheduler/scheduler.ts`.
- LLM span path: `packages/core/src/core/client.ts` and telemetry helpers under
  `packages/core/src/telemetry`.
- Tool span path: `packages/core/src/scheduler/tool-executor.ts`.
- Phoenix/OpenTelemetry setup: `packages/core/src/telemetry/sdk.ts`.
- Phoenix MCP self-introspection:
  `packages/core/src/telemetry/phoenixSelfIntrospection.ts`.
- Repair planner: `packages/core/src/tracepilot/repairPlanner.ts`.
- Deterministic evals: `packages/core/src/tracepilot/evals.ts` and
  `scripts/tracepilot-evals.ts`.
- Hosted proof surface: `scripts/tracepilot-cloud-run-server.mjs`,
  `scripts/tracepilot-cloud-run-deploy.mjs`, and
  `Dockerfile.tracepilot-cloud-run`.
- Demo fixture: `examples/broken-node-app`.

## Repository Structure

```text
.
|-- packages/
|   |-- cli/                  # Gemini CLI terminal package and entrypoints
|   |-- core/                 # Agent runtime, scheduler, tools, telemetry
|   |-- test-utils/           # Shared test helpers
|   `-- vscode-ide-companion/ # Upstream IDE companion package
|-- packages/core/src/
|   |-- telemetry/            # Phoenix OTEL, redaction, span helpers, MCP query
|   |-- tracepilot/           # Repair planner and deterministic evals
|   |-- policy/               # Command risk and safety gate logic
|   |-- scheduler/            # Agent turn and tool execution path
|   `-- tools/                # Shell, file, MCP, and other tool implementations
|-- examples/
|   `-- broken-node-app/      # Deterministic fail-plan-fix-rerun demo fixture
|-- scripts/                  # Smoke tests, demos, Cloud Run deploy/server tools
|-- docs/                     # TracePilot evidence plus upstream Gemini CLI docs
|-- integration-tests/        # Upstream integration test harness
|-- .github/                  # GitHub workflows, issue templates, repo automation
`-- cloudbuild.tracepilot-cloud-run.yaml
```

## TracePilot Status

### Working

- Gemini CLI builds, lints, and focused typecheck slices pass.
- Phoenix OTEL export works with real Phoenix Cloud configuration.
- Phoenix MCP visibility is proven by `npm run smoke:phoenix:mcp`.
- Agent, LLM, shell, file, MCP, Phoenix MCP, self-introspection, repair-plan,
  and eval paths emit TracePilot/OpenInference-oriented spans.
- Tool output previews are redacted and truncated before they reach traces, eval
  reports, or repair evidence.
- The command safety gate blocks destructive or credential-dumping commands and
  requires confirmation for high-risk commands.
- Deterministic TracePilot evals write machine-readable JSON.
- `examples/broken-node-app` proves both offline repair and strict
  Phoenix-backed repair.
- Cloud Run deploy/smoke tooling is present for later redeployment.

### Honest Limits

- The repair planner is deterministic and evidence-driven; it is not a general
  LLM judge.
- Redaction is pattern-based and tested for implemented secret formats. It is
  not a full DLP product.
- Full root `npm test` is still long locally; use focused slices and CI gates.
- Any key pasted into chat or logs should be treated as compromised and rotated
  before final public submission.
- Keep this fork private until the final submission package is ready.

### Required Environment

Copy `.env.example` and set real values locally. Do not commit secrets.

```bash
GEMINI_API_KEY=...
PHOENIX_API_KEY=...
PHOENIX_HOST=https://app.phoenix.arize.com/s/YOUR_REAL_SPACE
PHOENIX_BASE_URL=https://app.phoenix.arize.com/s/YOUR_REAL_SPACE
PHOENIX_COLLECTOR_ENDPOINT=
PHOENIX_PROJECT=tracepilot-gemini-cli
```

Phoenix MCP needs a real Phoenix base URL. TracePilot smoke/demo scripts resolve
it from `PHOENIX_HOST`, `PHOENIX_BASE_URL`, or a Phoenix Cloud-style
`PHOENIX_COLLECTOR_ENDPOINT`. `PHOENIX_BASE_URL` or `PHOENIX_COLLECTOR_ENDPOINT`
is used by OTEL export. For Phoenix Cloud, keep the host/base URL pointed at the
same space and set the project name you expect to query.

### Local Verification

Use focused slices for day-to-day work; the full root test suite is long.

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npx vitest run --coverage=false packages/core/src/telemetry/phoenixSelfIntrospection.test.ts packages/core/src/tracepilot/repairPlanner.test.ts
npx vitest run --coverage=false packages/core/src/policy/shell-safety.test.ts packages/core/src/policy/tracepilot-command-risk.test.ts
npm run test:scripts
```

Phoenix smoke checks:

```bash
npm run smoke:phoenix
npm run smoke:phoenix:mcp
```

Demo checks:

```bash
npm run demo:broken-node-app:offline
npm run demo:broken-node-app
```

Hosted checks, after redeploying Cloud Run:

```bash
npm run smoke:cloud-run:local
npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"
```

The offline demo proves the local repair path. The strict demo proves Phoenix
export, Phoenix MCP queryability, trace-evidence repair planning, rerun pass,
and eval logging.

### Verification Matrix

| Feature                        | Command/test                                                                          | Current status                   | Evidence                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Baseline install               | `npm ci`                                                                              | Working                          | Passed in baseline health check.                                                                                             |
| Build                          | `npm run build`                                                                       | Working                          | Passed for issues #11, #12, and #13. Build rewrites generated git-commit files; restore them before committing if needed.    |
| Lint                           | `npm run lint`                                                                        | Working                          | Passed for issues #11, #12, and #13.                                                                                         |
| Typecheck                      | `npm run typecheck`                                                                   | Working                          | Passed for issues #11, #12, and #13.                                                                                         |
| Full root tests                | `npm test`                                                                            | Unverified/long                  | Root test run exceeded the local 30 minute budget during audit; use focused slices until CI is hardened.                     |
| Phoenix OTEL init/export smoke | `npm run smoke:phoenix`                                                               | Working                          | Passed for session `tracepilot-smoke-1778699160858`.                                                                         |
| Phoenix MCP visibility         | `npm run smoke:phoenix:mcp`                                                           | Working                          | Passed for session `tracepilot-mcp-smoke-1778699158476`; Phoenix MCP returned trace `f3e4acf2ed12c206429ff4b82fbe0d00`.      |
| Agent/LLM spans                | Core telemetry tests                                                                  | Working                          | `gemini_cli.agent_turn` and `gemini_cli.llm.generate` span paths are covered.                                                |
| Shell/file/MCP spans           | Scheduler/tool tests                                                                  | Working                          | Tool spans include safe metadata, risk, output preview/hash, and Phoenix MCP specialization.                                 |
| Redaction                      | `packages/core/src/telemetry/sanitize.test.ts` and eval/demo tests                    | Working for implemented patterns | Secrets are redacted before trace/eval/demo previews.                                                                        |
| Command safety gate            | `packages/core/src/policy/shell-safety.test.ts` and `tracepilot-command-risk.test.ts` | Working                          | Blocks `rm -rf /`, `.env` reads, env dumps, and recursive secret searches; high-risk commands ask for confirmation.          |
| Self-introspection             | Phoenix MCP smoke, strict demo, and scheduler tests                                   | Working                          | Strict demo queried Phoenix MCP and attached trace evidence to the repair plan.                                              |
| Repair planner                 | `packages/core/src/tracepilot/repairPlanner.test.ts`                                  | Working locally                  | Planner consumes structured trace evidence, emits `gemini_cli.chain.repair_plan`, and degrades when evidence is unavailable. |
| Deterministic evals            | `npm run test:scripts`                                                                | Working locally                  | Eval runner writes sanitized JSON and checks required deterministic eval IDs.                                                |
| Broken repo demo               | `npm run demo:broken-node-app`                                                        | Working                          | Strict demo passed with Phoenix trace `de13112b1dadd28dda63a83365d92344` and all deterministic evals.                        |
| Cloud Run local smoke          | `npm run smoke:cloud-run:local`                                                       | Working locally                  | Verifies the deployable health/status/demo surface without requiring a live service.                                         |
| Hosted Cloud Run URL           | `npm run smoke:cloud-run -- --url "$CLOUD_RUN_SERVICE_URL"`                           | Not currently deployed           | User intentionally removed Cloud Run for now; redeploy later with the included cheap deploy helper before sharing a URL.     |

See [docs/tracepilot.md](docs/tracepilot.md) for the same status in a
task-focused format.

[![Gemini CLI CI](https://github.com/google-gemini/gemini-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/google-gemini/gemini-cli/actions/workflows/ci.yml)
[![Gemini CLI E2E (Chained)](https://github.com/google-gemini/gemini-cli/actions/workflows/chained_e2e.yml/badge.svg)](https://github.com/google-gemini/gemini-cli/actions/workflows/chained_e2e.yml)
[![Version](https://img.shields.io/npm/v/@google/gemini-cli)](https://www.npmjs.com/package/@google/gemini-cli)
[![License](https://img.shields.io/github/license/google-gemini/gemini-cli)](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE)
[![View Code Wiki](https://assets.codewiki.google/readme-badge/static.svg)](https://codewiki.google/github.com/google-gemini/gemini-cli?utm_source=badge&utm_medium=github&utm_campaign=github.com/google-gemini/gemini-cli)

![Gemini CLI Screenshot](/docs/assets/gemini-screenshot.png)

Gemini CLI is an open-source AI agent that brings the power of Gemini directly
into your terminal. It provides lightweight access to Gemini, giving you the
most direct path from your prompt to our model.

Learn all about Gemini CLI in our [documentation](https://geminicli.com/docs/).

## 🚀 Why Gemini CLI?

- **🎯 Free tier**: 60 requests/min and 1,000 requests/day with personal Google
  account.
- **🧠 Powerful Gemini 3 models**: Access to improved reasoning and 1M token
  context window.
- **🔧 Built-in tools**: Google Search grounding, file operations, shell
  commands, web fetching.
- **🔌 Extensible**: MCP (Model Context Protocol) support for custom
  integrations.
- **💻 Terminal-first**: Designed for developers who live in the command line.
- **🛡️ Open source**: Apache 2.0 licensed.

## 📦 Installation

See
[Gemini CLI installation, execution, and releases](https://www.geminicli.com/docs/get-started/installation)
for recommended system specifications and a detailed installation guide.

### Quick Install

#### Run instantly with npx

```bash
# Using npx (no installation required)
npx @google/gemini-cli
```

#### Install globally with npm

```bash
npm install -g @google/gemini-cli
```

#### Install globally with Homebrew (macOS/Linux)

```bash
brew install gemini-cli
```

#### Install globally with MacPorts (macOS)

```bash
sudo port install gemini-cli
```

#### Install with Anaconda (for restricted environments)

```bash
# Create and activate a new environment
conda create -y -n gemini_env -c conda-forge nodejs
conda activate gemini_env

# Install Gemini CLI globally via npm (inside the environment)
npm install -g @google/gemini-cli
```

## Release Channels

See [Releases](https://www.geminicli.com/docs/changelogs) for more details.

### Preview

New preview releases will be published each week at UTC 23:59 on Tuesdays. These
releases will not have been fully vetted and may contain regressions or other
outstanding issues. Please help us test and install with `preview` tag.

```bash
npm install -g @google/gemini-cli@preview
```

### Stable

- New stable releases will be published each week at UTC 20:00 on Tuesdays, this
  will be the full promotion of last week's `preview` release + any bug fixes
  and validations. Use `latest` tag.

```bash
npm install -g @google/gemini-cli@latest
```

### Nightly

- New releases will be published each day at UTC 00:00. This will be all changes
  from the main branch as represented at time of release. It should be assumed
  there are pending validations and issues. Use `nightly` tag.

```bash
npm install -g @google/gemini-cli@nightly
```

## 📋 Key Features

### Code Understanding & Generation

- Query and edit large codebases
- Generate new apps from PDFs, images, or sketches using multimodal capabilities
- Debug issues and troubleshoot with natural language

### Automation & Integration

- Automate operational tasks like querying pull requests or handling complex
  rebases
- Use MCP servers to connect new capabilities, including
  [media generation with Imagen, Veo or Lyria](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia)
- Run non-interactively in scripts for workflow automation

### Advanced Capabilities

- Ground your queries with built-in
  [Google Search](https://ai.google.dev/gemini-api/docs/grounding) for real-time
  information
- Conversation checkpointing to save and resume complex sessions
- Custom context files (GEMINI.md) to tailor behavior for your projects

### GitHub Integration

Integrate Gemini CLI directly into your GitHub workflows with
[**Gemini CLI GitHub Action**](https://github.com/google-github-actions/run-gemini-cli):

- **Pull Request Reviews**: Automated code review with contextual feedback and
  suggestions
- **Issue Triage**: Automated labeling and prioritization of GitHub issues based
  on content analysis
- **On-demand Assistance**: Mention `@gemini-cli` in issues and pull requests
  for help with debugging, explanations, or task delegation
- **Custom Workflows**: Build automated, scheduled and on-demand workflows
  tailored to your team's needs

## 🔐 Authentication Options

Choose the authentication method that best fits your needs:

### Option 1: Sign in with Google (OAuth login using your Google Account)

**✨ Best for:** Individual developers as well as anyone who has a Gemini Code
Assist License. (see
[quota limits and terms of service](https://cloud.google.com/gemini/docs/quotas)
for details)

**Benefits:**

- **Free tier**: 60 requests/min and 1,000 requests/day
- **Gemini 3 models** with 1M token context window
- **No API key management** - just sign in with your Google account
- **Automatic updates** to latest models

#### Start Gemini CLI, then choose _Sign in with Google_ and follow the browser authentication flow when prompted

```bash
gemini
```

#### If you are using a paid Code Assist License from your organization, remember to set the Google Cloud Project

```bash
# Set your Google Cloud Project
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"
gemini
```

### Option 2: Gemini API Key

**✨ Best for:** Developers who need specific model control or paid tier access

**Benefits:**

- **Free tier**: 1000 requests/day with Gemini 3 (mix of flash and pro)
- **Model selection**: Choose specific Gemini models
- **Usage-based billing**: Upgrade for higher limits when needed

```bash
# Get your key from https://aistudio.google.com/apikey
export GEMINI_API_KEY="YOUR_API_KEY"
gemini
```

### Option 3: Vertex AI

**✨ Best for:** Enterprise teams and production workloads

**Benefits:**

- **Enterprise features**: Advanced security and compliance
- **Scalable**: Higher rate limits with billing account
- **Integration**: Works with existing Google Cloud infrastructure

```bash
# Get your key from Google Cloud Console
export GOOGLE_API_KEY="YOUR_API_KEY"
export GOOGLE_GENAI_USE_VERTEXAI=true
gemini
```

For Google Workspace accounts and other authentication methods, see the
[authentication guide](https://www.geminicli.com/docs/get-started/authentication).

## 🚀 Getting Started

### Basic Usage

#### Start in current directory

```bash
gemini
```

#### Include multiple directories

```bash
gemini --include-directories ../lib,../docs
```

#### Use specific model

```bash
gemini -m gemini-2.5-flash
```

#### Non-interactive mode for scripts

Get a simple text response:

```bash
gemini -p "Explain the architecture of this codebase"
```

For more advanced scripting, including how to parse JSON and handle errors, use
the `--output-format json` flag to get structured output:

```bash
gemini -p "Explain the architecture of this codebase" --output-format json
```

For real-time event streaming (useful for monitoring long-running operations),
use `--output-format stream-json` to get newline-delimited JSON events:

```bash
gemini -p "Run tests and deploy" --output-format stream-json
```

### Quick Examples

#### Start a new project

```bash
cd new-project/
gemini
> Write me a Discord bot that answers questions using a FAQ.md file I will provide
```

#### Analyze existing code

```bash
git clone https://github.com/google-gemini/gemini-cli
cd gemini-cli
gemini
> Give me a summary of all of the changes that went in yesterday
```

## 📚 Documentation

### Getting Started

- [**Quickstart Guide**](https://www.geminicli.com/docs/get-started) - Get up
  and running quickly.
- [**Authentication Setup**](https://www.geminicli.com/docs/get-started/authentication) -
  Detailed auth configuration.
- [**Configuration Guide**](https://www.geminicli.com/docs/reference/configuration) -
  Settings and customization.
- [**Keyboard Shortcuts**](https://www.geminicli.com/docs/reference/keyboard-shortcuts) -
  Productivity tips.

### Core Features

- [**Commands Reference**](https://www.geminicli.com/docs/reference/commands) -
  All slash commands (`/help`, `/chat`, etc).
- [**Custom Commands**](https://www.geminicli.com/docs/cli/custom-commands) -
  Create your own reusable commands.
- [**Context Files (GEMINI.md)**](https://www.geminicli.com/docs/cli/gemini-md) -
  Provide persistent context to Gemini CLI.
- [**Checkpointing**](https://www.geminicli.com/docs/cli/checkpointing) - Save
  and resume conversations.
- [**Token Caching**](https://www.geminicli.com/docs/cli/token-caching) -
  Optimize token usage.

### Tools & Extensions

- [**Built-in Tools Overview**](https://www.geminicli.com/docs/reference/tools)
  - [File System Operations](https://www.geminicli.com/docs/tools/file-system)
  - [Shell Commands](https://www.geminicli.com/docs/tools/shell)
  - [Web Fetch & Search](https://www.geminicli.com/docs/tools/web-fetch)
- [**MCP Server Integration**](https://www.geminicli.com/docs/tools/mcp-server) -
  Extend with custom tools.
- [**Custom Extensions**](https://geminicli.com/docs/extensions/writing-extensions) -
  Build and share your own commands.

### Advanced Topics

- [**Headless Mode (Scripting)**](https://www.geminicli.com/docs/cli/headless) -
  Use Gemini CLI in automated workflows.
- [**IDE Integration**](https://www.geminicli.com/docs/ide-integration) - VS
  Code companion.
- [**Sandboxing & Security**](https://www.geminicli.com/docs/cli/sandbox) - Safe
  execution environments.
- [**Trusted Folders**](https://www.geminicli.com/docs/cli/trusted-folders) -
  Control execution policies by folder.
- [**Enterprise Guide**](https://www.geminicli.com/docs/cli/enterprise) - Deploy
  and manage in a corporate environment.
- [**Telemetry & Monitoring**](https://www.geminicli.com/docs/cli/telemetry) -
  Usage tracking.
- [**Tools reference**](https://www.geminicli.com/docs/reference/tools) -
  Built-in tools overview.
- [**Local development**](https://www.geminicli.com/docs/local-development) -
  Local development tooling.

### Troubleshooting & Support

- [**Troubleshooting Guide**](https://www.geminicli.com/docs/resources/troubleshooting) -
  Common issues and solutions.
- [**FAQ**](https://www.geminicli.com/docs/resources/faq) - Frequently asked
  questions.
- Use `/bug` command to report issues directly from the CLI.

### Using MCP Servers

Configure MCP servers in `~/.gemini/settings.json` to extend Gemini CLI with
custom tools:

```text
> @github List my open pull requests
> @slack Send a summary of today's commits to #dev channel
> @database Run a query to find inactive users
```

See the
[MCP Server Integration guide](https://www.geminicli.com/docs/tools/mcp-server)
for setup instructions.

## 🤝 Contributing

We welcome contributions! Gemini CLI is fully open source (Apache 2.0), and we
encourage the community to:

- Report bugs and suggest features.
- Improve documentation.
- Submit code improvements.
- Share your MCP servers and extensions.

See our [Contributing Guide](./CONTRIBUTING.md) for development setup, coding
standards, and how to submit pull requests.

Check our [Official Roadmap](https://github.com/orgs/google-gemini/projects/11)
for planned features and priorities.

## 📖 Resources

- **[Free Course](https://learn.deeplearning.ai/courses/gemini-cli-code-and-create-with-an-open-source-agent/information)** -
  Learn the basics.
- **[Official Roadmap](./ROADMAP.md)** - See what's coming next.
- **[Changelog](https://www.geminicli.com/docs/changelogs)** - See recent
  notable updates.
- **[NPM Package](https://www.npmjs.com/package/@google/gemini-cli)** - Package
  registry.
- **[GitHub Issues](https://github.com/google-gemini/gemini-cli/issues)** -
  Report bugs or request features.
- **[Security Advisories](https://github.com/google-gemini/gemini-cli/security/advisories)** -
  Security updates.

### Uninstall

See the [Uninstall Guide](https://www.geminicli.com/docs/resources/uninstall)
for removal instructions.

## 📄 Legal

- **License**: [Apache License 2.0](LICENSE)
- **Terms of Service**:
  [Terms & Privacy](https://www.geminicli.com/docs/resources/tos-privacy)
- **Security**: [Security Policy](SECURITY.md)

<p align="left">
 <a href="https://www.star-history.com/google-gemini/gemini-cli">
  <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=google-gemini/gemini-cli&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=google-gemini/gemini-cli" />
   <img alt="Star History Rank" src="https://api.star-history.com/badge?repo=google-gemini/gemini-cli" />
  </picture>
 </a>
</p>

---

<p align="center">
  Built with ❤️ by Google and the open source community
</p>
