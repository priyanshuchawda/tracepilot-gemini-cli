#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const pointer = path.resolve(
  '.ai-logs/tracepilot-independent-eval/phase2-nextjs/latest-agent-comparison.txt',
);
const reportPath = (await readFile(pointer, 'utf8')).trim();
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const paced = process.argv.includes('--paced');

await section('TracePilot Closed Next.js Issue Evidence');
line(`Report: ${reportPath}`);
line(`Generated: ${report.generatedAt}`);
line(`Model: ${report.model}`);
line(`Timeout: ${Math.round(report.timeoutMs / 1000)}s per arm`);
line(`Fairness: ${report.fairness.treatmentDifference}`);

await section('Scoreboard');
for (const [arm, summary] of Object.entries(report.summary.byArm)) {
  line(
    `${arm.padEnd(10)} fixed=${summary.fixed}/${summary.total} ` +
      `repairTime=${Math.round(summary.totalRepairTimeMs / 1000)}s ` +
      `phoenixMentioned=${summary.phoenixEvidenceMentioned}/${summary.total}`,
  );
}

await section('Per-Issue Outcomes');
for (const result of report.results) {
  line(
    `${result.benchmarkId.padEnd(10)} ${result.arm.padEnd(10)} ` +
      `fixed=${String(result.fixed).padEnd(5)} ` +
      `before=${result.before.exitCode} after=${result.after.exitCode} ` +
      `duration=${Math.round(result.agent.durationMs / 1000)}s`,
  );
  line(`  verifier: ${result.verifierCommand}`);
  line(`  session:  ${result.sessionId}`);
  line(`  changed:  ${result.changedFiles.join(', ') || '(none)'}`);
}

await section('Gemini Terminal Evidence Snippets');
for (const result of report.results) {
  await subsection(`${result.benchmarkId} / ${result.arm}`);
  line(`Session ID: ${result.sessionId}`);
  line(`Fixed: ${result.fixed}`);
  line(`Verifier after exit: ${result.after.exitCode}`);
  line(`Phoenix evidence access: ${result.metrics.phoenixEvidenceAccess}`);
  line(`Phoenix/MCP mentioned: ${result.metrics.phoenixEvidenceMentioned}`);
  line('');
  line(trimSnippet(result.agent.outputPreview));
}

await section('Verifier Proof Snippets');
for (const result of report.results) {
  await subsection(`${result.benchmarkId} / ${result.arm}`);
  line(`Before verifier exit: ${result.before.exitCode}`);
  line(trimSnippet(result.before.outputPreview, 900));
  line('');
  line(`After verifier exit: ${result.after.exitCode}`);
  line(trimSnippet(result.after.outputPreview, 900));
}

await section('End');
line('This terminal replay is generated from the recorded live benchmark report and raw agent/verifier outputs.');
line('Use the JSON report for exact hashes, output previews, changed files, session IDs, and timing.');

function line(value = '') {
  console.log(value);
}

async function section(title) {
  if (paced) await sleep(1200);
  line('');
  line('='.repeat(88));
  line(title);
  line('='.repeat(88));
}

async function subsection(title) {
  if (paced) await sleep(1000);
  line('');
  line('-'.repeat(88));
  line(title);
  line('-'.repeat(88));
}

function trimSnippet(value, limit = 1600) {
  const compact = String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 26)
    .join('\n');
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}\n...[truncated]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
