# Cleanup Report

Cleanup date: 2026-06-11

The cleanup was limited to isolated submission artifacts. No runtime behavior,
repair-memory behavior, Phoenix integration, verification infrastructure,
evidence-generation tooling, or deployment tooling changed.

Repository reduction:

- 17 files removed
- 3,095 lines removed
- No generated artifacts added

## Deleted Files

Temporary demo launchers:

- `open-demo.ps1`
- `serve-dashboard.js`

Local probe:

- `scripts/_probe-phoenix-emit.mjs`

One-off benchmark dashboard renderers:

- `scripts/build-nextjs-five-dashboard.mjs`
- `scripts/build-nextjs-hackathon-dashboard.mjs`

Temporary recording automation:

- `scripts/record-nextjs-dashboard-demo.mjs`
- `scripts/record-nextjs-five-terminal-comparison.mjs`
- `scripts/record-nextjs-hackathon-demo.mjs`
- `scripts/record-nextjs-terminal-comparison.mjs`
- `scripts/record-tracepilot-comparison.mjs`

Temporary video-edit assets:

- `scripts/video/clip-01-failure.mjs`
- `scripts/video/clip-03-phoenix.mjs`
- `scripts/video/clip-05-diff.mjs`
- `scripts/video/clip-07-results.mjs`
- `scripts/video/combine-all.ps1`
- `scripts/video/record-all-clips.ps1`
- `scripts/video/record-clip.ps1`

## Archived Files

No files were moved. The audit identifies historical documents and bounded
engineering evidence retained in place to avoid breaking links.

## Guardrails Added

`.gitignore` now excludes raw recordings, rendered videos, benchmark output,
temporary reports, logs, local cloud/deployment state, build caches, coverage,
and common test output.

## Confirmed Submission Blockers Fixed

GitHub TracePilot CI exposed one fail-closed safety regression and seven lint
errors already present on `main`:

- Malformed shell operator runs such as `&&&` now classify as a high-risk
  `parse_error`.
- Unused imports/variables and one unnecessary type assertion were removed.
- ESLint now ignores generated TracePilot run output, preventing focused tests
  from making the following lint gate fail on `.ai-logs/` fixtures.
