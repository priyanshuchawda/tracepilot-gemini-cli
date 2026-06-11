# Submission Readiness

Review date: 2026-06-11

## Summary

The repository presents a clear judge path and preserves the implementation
needed to demonstrate that TracePilot stores verified repairs, retrieves
matching evidence through Phoenix, and uses that evidence in later repair
planning. Cleanup changes do not alter runtime behavior.

## Critical

- **Executable release verification is incomplete on this workstation.**
  `npm ci` failed with `ENOSPC` while extracting dependencies. At failure time,
  the C: drive had approximately 212 MB free. Build, typecheck, focused tests,
  controlled repair-memory replay, offline demo, and local Cloud Run smoke
  therefore could not be executed in this checkout.

Required resolution before merge: run the PR's `TracePilot CI` workflow
successfully or rerun the documented local checks on a machine with sufficient
disk space.

## High

- **No hosted Cloud Run URL is currently presented.** This is accurately
  disclosed in the README. The deployment script, Cloud Build config,
  container definition, secret handling, and smoke script are retained, but a
  hosted claim requires a fresh deploy and hosted smoke result.

## Medium

- **Live Phoenix proof requires judge credentials.** The README now separates
  the credential-free controlled path from live OTEL/MCP verification.
- **The committed ablation result is intentionally narrow.** It is retained as
  bounded engineering evidence and explicitly does not claim general benchmark
  performance.

## Low

- The repository remains a large Gemini CLI fork. Upstream workflows,
  documentation assets, vendored runtime binaries, and test fixtures dominate
  size, but removing them would reduce reproducibility or alter the supported
  runtime.

## Static Verification Completed

- Clean baseline confirmed before edits
- Removed-file reference audit completed
- `git diff --check` passed
- TracePilot CI workflow reviewed
- Cloud Run Dockerfile, Cloud Build config, deployment script, server, and
  smoke script reviewed
- README judge path reviewed against the submission objective

## Required Checks Before Merge

```bash
npm ci
npm run test:tracepilot
npm run typecheck
npm run build
npm run demo:phoenix-repair-memory:controlled
npm run demo:broken-node-app:offline
npm run smoke:cloud-run:local
```

The GitHub `TracePilot CI` workflow runs the medium gate, including focused
tests, lint, typecheck, build, and the offline broken-node demo. Merge only
after that workflow succeeds.
