# Repository Audit

Audit date: 2026-06-11

Scope: complete clean checkout of `main`, excluding Git object storage and
untracked dependency installation output.

Baseline:

- 2,982 working-tree files
- 107,146,037 bytes
- Clean working tree before cleanup
- No committed raw recordings, rendered videos, logs, build output, coverage,
  local Cloud Run output, or benchmark result directories

## KEEP

The following are required for the submission, reproducibility, or the upstream
Gemini CLI runtime:

- `packages/`, including repair memory, Phoenix telemetry, policy, CLI, and
  tests
- `scripts/tracepilot-*`, `scripts/demo-*`, Phoenix smoke scripts, repair-memory
  report generators, comparison/evidence generators, and controlled test
  runners
- `docs/`, including the bounded committed ablation evidence in
  `docs/evidence/trace-ablation-2026-06-07.json`
- `examples/`, including deterministic broken-repository fixtures
- `.github/workflows/tracepilot-ci.yml` and upstream build/test workflows
- `Dockerfile.tracepilot-cloud-run`,
  `cloudbuild.tracepilot-cloud-run.yaml`, Cloud Run scripts, and `.gcloudignore`
- Root build, package, licensing, security, and contributor files
- Upstream Gemini CLI eval, integration, memory, and performance test fixtures
- Vendored ripgrep binaries required by the CLI runtime

## ARCHIVE

These are retained because they document implementation history or bounded
engineering evidence, but they are not the primary judge path:

- `PLAN.md`, `ROADMAP.md`, `docs.md`
- `docs/tracepilot-implementation-readme.md`
- `docs/tracepilot-release-demo-checklist.md`
- `docs/evidence/trace-ablation-2026-06-07.json`
- Upstream Gemini CLI release and operations documentation

Archive means retained in place for this submission. Moving these files would
break links or create unnecessary repository churn.

## REMOVE

The following were isolated from supported package scripts and documentation:

- `scripts/video/`: temporary multi-clip recording and video-edit automation
- `scripts/record-*.mjs`: temporary browser/terminal recording automation
- `scripts/build-nextjs-*-dashboard.mjs`: one-off benchmark dashboard renderers
- `open-demo.ps1` and `serve-dashboard.js`: launchers coupled to ignored local
  benchmark output
- `scripts/_probe-phoenix-emit.mjs`: local probe with a machine-specific `.env`
  path and credential-prefix logging

## Risk Notes

- `memory-tests/large-chat-session.json` is the largest file at 56,434,129
  bytes. It is retained because it is an upstream memory test fixture, not a
  generated local artifact.
- `docs/assets/` contains committed documentation images. They are retained
  because they are referenced by upstream documentation.
- No repair-memory behavior, Phoenix integration, verification infrastructure,
  evidence-generation tooling, or deployment tooling was removed.
