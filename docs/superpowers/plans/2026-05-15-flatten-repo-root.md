# Flatten Repo Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Move the TracePilot TypeScript monorepo from `gemini-cli/` to the
repository root so GitHub shows the actual project immediately.

**Architecture:** Preserve the polished root README as the GitHub landing page,
move tracked project files up one level with `git mv`, and merge the root
metadata additions into the real project `.gitignore` and `.github` structure.
Keep generated logs, temp files, dependencies, and secrets untracked.

**Tech Stack:** Git, TypeScript monorepo, npm, GitHub issue/PR templates, GitHub
Actions.

---

### Task 1: Resolve Root Collisions

**Files:**

- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/tracepilot_fix.md`

- [x] **Step 1: Keep the root README as the landing page**

Use the existing root `README.md` as the final public README. Update links after
flattening so paths no longer start with `gemini-cli/`.

- [x] **Step 2: Preserve the project README**

Move `gemini-cli/README.md` to `docs/tracepilot-implementation-readme.md` so the
fuller implementation README is not lost.

- [x] **Step 3: Merge ignore rules**

Use the project `.gitignore` as the base and add root-local rules for
`.ai-logs/`, `.ai-tmp/`, and `.env.*` while keeping `.env.example` tracked.

- [x] **Step 4: Merge GitHub templates**

Keep existing workflow files from `gemini-cli/.github/`, keep the fuller
existing PR template, and add TracePilot evidence checklist fields.

### Task 2: Move Project Files

**Files:**

- Move: `gemini-cli/**` to repository root

- [x] **Step 1: Move non-colliding tracked files**

Run a tracked-file move that excludes `gemini-cli/README.md`,
`gemini-cli/.gitignore`, and `gemini-cli/.github/**`.

- [x] **Step 2: Move `.github` contents into root**

Move workflow, action, script, CODEOWNERS, dependabot, and issue template files
from `gemini-cli/.github/` into root `.github/`.

- [x] **Step 3: Remove the empty wrapper directory**

Confirm no tracked files remain under `gemini-cli/` and leave untracked local
logs/dependencies ignored.

### Task 3: Verify And Publish

**Files:**

- Check: all moved files

- [x] **Step 1: Run formatting and diff checks**

Run:

```bash
npx prettier --write README.md .github/pull_request_template.md .github/ISSUE_TEMPLATE/tracepilot_fix.md docs/superpowers/plans/2026-05-15-flatten-repo-root.md
git diff --check
```

- [x] **Step 2: Run cheap project gates**

Run:

```bash
npm run lint
npm run smoke:cloud-run:local
```

- [ ] **Step 3: Commit, push, and open PR**

Commit the flattening change with `Closes #42`, push
`issue-42-flatten-project-root`, and merge only after required checks pass.
