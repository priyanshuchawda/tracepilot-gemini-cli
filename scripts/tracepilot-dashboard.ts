#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateTracePilotEvalReport,
  type TracePilotEvalReport,
} from '../packages/core/src/tracepilot/evals.js';
import {
  validateTracePilotJudgeInput,
  validateTracePilotJudgeResult,
  type TracePilotJudgeInput,
  type TracePilotJudgeResult,
} from '../packages/core/src/tracepilot/judgeEvidence.js';
import { validateTracePilotProofReport } from '../packages/core/src/tracepilot/proofReport.js';
import {
  validateTracePilotRepairArtifact,
  type TracePilotRepairArtifact,
} from '../packages/core/src/tracepilot/repairReport.js';
import { redactSensitiveText } from '../packages/core/src/telemetry/sanitize.js';

interface CliOptions {
  report?: string;
  repairArtifact?: string;
  judgeInput?: string;
  judgeResult?: string;
  output: string;
}

interface DashboardInput {
  report: Record<string, unknown>;
  repairArtifact?: TracePilotRepairArtifact;
  evalReport?: TracePilotEvalReport;
  judgeInput?: TracePilotJudgeInput;
  judgeResult?: TracePilotJudgeResult;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options.report) {
    console.error(
      [
        'Usage: npm run dashboard:tracepilot --',
        '--report <proof-result.json>',
        '[--repair-artifact <repair-artifact.json>]',
        '[--judge-input <judge-input.json>]',
        '[--judge-result <judge-result.json>]',
        '[--output <index.html>]',
      ].join(' '),
    );
    return 2;
  }

  try {
    const input = await readDashboardInput(options);
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, renderDashboard(input), 'utf8');
    console.log(`TracePilot proof dashboard: ${output}`);
    return 0;
  } catch (error) {
    console.error(
      `Failed to write TracePilot proof dashboard: ${sanitize(getErrorMessage(error))}`,
    );
    return 2;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    output: path.join('.ai-logs', 'tracepilot-dashboard', 'index.html'),
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--report') {
      options.report = argv[++index];
    } else if (arg === '--repair-artifact') {
      options.repairArtifact = argv[++index];
    } else if (arg === '--judge-input') {
      options.judgeInput = argv[++index];
    } else if (arg === '--judge-result') {
      options.judgeResult = argv[++index];
    } else if (arg === '--output') {
      options.output = argv[++index] ?? options.output;
    }
  }
  return options;
}

async function readDashboardInput(
  options: CliOptions,
): Promise<DashboardInput> {
  const report = validateTracePilotProofReport(
    await readJsonFile(required(options.report, 'report')),
  );
  const repairArtifact = options.repairArtifact
    ? validateTracePilotRepairArtifact(
        await readJsonFile(options.repairArtifact),
      )
    : getRecord(report['repairArtifact'])
      ? validateTracePilotRepairArtifact(report['repairArtifact'])
      : undefined;
  const evalReport = getRecord(report['eval'])
    ? validateTracePilotEvalReport(report['eval'])
    : undefined;
  const judgeInput = options.judgeInput
    ? validateTracePilotJudgeInput(await readJsonFile(options.judgeInput))
    : undefined;
  const judgeResult = options.judgeResult
    ? validateTracePilotJudgeResult(await readJsonFile(options.judgeResult))
    : getRecord(getRecord(report['judge'])?.['result'])
      ? validateTracePilotJudgeResult(getRecord(report['judge'])?.['result'])
      : undefined;
  return {
    report,
    repairArtifact,
    evalReport,
    judgeInput,
    judgeResult,
  };
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Missing required ${name}.`);
  }
  return value;
}

function renderDashboard(input: DashboardInput): string {
  const report = input.report;
  const proofLevel = stringValue(report['proofLevel']) ?? 'unknown';
  const ok = booleanValue(report['ok']);
  const strictLiveProof = booleanValue(report['strictLiveProof']);
  const sessionId =
    stringValue(report['sessionId']) ??
    input.repairArtifact?.sessionId ??
    stringValue(input.judgeInput?.repair.sessionId) ??
    'unknown';
  const filesChanged =
    getStringArray(getRecord(report['repair'])?.['changedFiles']) ??
    input.repairArtifact?.repair.filesModified ??
    input.judgeInput?.repair.filesModified ??
    [];
  const evalReport = input.evalReport;
  const judgeResult = input.judgeResult;
  const timeline = buildTimeline(input);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TracePilot Proof Viewer</title>
  <style>${css()}</style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">TracePilot Proof Viewer</p>
        <h1>${escapeHtml(statusTitle(ok, strictLiveProof))}</h1>
        <p class="subtle">${escapeHtml(stringValue(report['proofSummary']) ?? 'Evidence bundle generated for review.')}</p>
      </div>
      <div class="status ${ok ? 'ok' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</div>
    </section>

    <section class="metrics">
      ${metric('Proof Level', proofLevel)}
      ${metric('Strict Live Proof', strictLiveProof ? 'yes' : 'no')}
      ${metric('Session', sessionId)}
      ${metric('Files Changed', String(filesChanged.length))}
      ${metric('Eval Status', evalReport?.ok === undefined ? 'missing' : evalReport.ok ? 'pass' : 'fail')}
      ${metric('Judge Mode', judgeResult?.mode ?? 'missing')}
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Repair Evidence Timeline</h2>
        <span>${escapeHtml(timeline.filter((step) => step.status === 'pass').length)} / ${escapeHtml(timeline.length)} passed</span>
      </div>
      <div class="timeline">
        ${timeline.map(renderTimelineStep).join('\n')}
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <div class="section-head"><h2>Changed Files</h2><span>${escapeHtml(filesChanged.length)}</span></div>
        ${renderChangedFiles(input, filesChanged)}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Safety</h2><span>${escapeHtml(safetyStatus(input))}</span></div>
        ${renderSafety(input)}
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <div class="section-head"><h2>Deterministic Evals</h2><span>${escapeHtml(evalReport?.ok ? 'pass' : evalReport ? 'fail' : 'missing')}</span></div>
        ${renderEvals(evalReport)}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Judge Evidence</h2><span>${escapeHtml(judgeResult?.mode ?? 'missing')}</span></div>
        ${renderJudge(judgeResult)}
      </div>
    </section>

    <section class="panel">
      <div class="section-head"><h2>Evidence Details</h2><span>sanitized</span></div>
      ${renderEvidenceDetails(input)}
    </section>
  </main>
</body>
</html>
`;
}

function buildTimeline(input: DashboardInput): Array<{
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}> {
  const report = input.report;
  const phoenix = getRecord(report['phoenix']);
  const causalTrace = getRecord(report['causalTrace']);
  const repair = getRecord(report['repair']);
  const retry = getRecord(report['retryTest']);
  const safetyEval = input.evalReport?.results.find(
    (result) => result.id === 'blocked_destructive_command',
  );
  return [
    {
      label: 'Failure Observed',
      status:
        input.repairArtifact !== undefined ||
        getRecord(report['initialTest']) !== undefined
          ? 'pass'
          : 'warn',
      detail:
        input.repairArtifact?.failure.summary ??
        'Initial failure evidence is not attached.',
    },
    {
      label: 'Phoenix Evidence',
      status:
        booleanValue(phoenix?.['visible']) ||
        booleanValue(causalTrace?.['failedToolSpan'])
          ? 'pass'
          : booleanValue(report['strictLiveProof'])
            ? 'fail'
            : 'warn',
      detail:
        stringValue(phoenix?.['traceId']) ??
        stringValue(input.repairArtifact?.phoenix.tracesConsulted[0]) ??
        'No live trace id attached.',
    },
    {
      label: 'Repair Applied',
      status:
        booleanValue(repair?.['onlyExpectedFilesChanged']) ||
        (input.repairArtifact?.repair.filesModified.length ?? 0) > 0
          ? 'pass'
          : 'warn',
      detail: `${filesChangedText(input)} changed file(s).`,
    },
    {
      label: 'Retry Verified',
      status:
        numberValue(retry?.['exitCode']) === 0 ||
        input.repairArtifact?.completion?.finalExitCode === 0
          ? 'pass'
          : 'fail',
      detail:
        stringValue(retry?.['command']) ??
        input.repairArtifact?.completion?.retryCommands.join(', ') ??
        'Retry command unavailable.',
    },
    {
      label: 'Safety Gate',
      status:
        safetyEval?.status === 'pass' ? 'pass' : safetyEval ? 'fail' : 'warn',
      detail:
        safetyEval?.failureReason ??
        'Destructive command block evidence not attached.',
    },
    {
      label: 'Judge Bundle',
      status: input.judgeResult ? 'pass' : 'warn',
      detail: input.judgeResult
        ? `${input.judgeResult.mode} result ready.`
        : 'Judge result artifact not attached.',
    },
  ];
}

function renderTimelineStep(step: {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}): string {
  return `<article class="step ${step.status}">
    <div class="dot"></div>
    <h3>${escapeHtml(step.label)}</h3>
    <p>${escapeHtml(step.detail)}</p>
  </article>`;
}

function renderEvals(report: TracePilotEvalReport | undefined): string {
  if (!report) {
    return empty('No deterministic eval report attached.');
  }
  return `<ul class="list compact">${report.results
    .map(
      (result) =>
        `<li><span class="pill ${result.status}">${escapeHtml(result.status)}</span>${escapeHtml(result.id)}${result.failureReason ? `<small>${escapeHtml(result.failureReason)}</small>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

function renderChangedFiles(
  input: DashboardInput,
  filesChanged: string[],
): string {
  if (filesChanged.length === 0) {
    return empty('No changed files reported.');
  }
  const patchesByFile = new Map(
    (input.repairArtifact?.repair.patches ?? []).map((patch) => [
      patch.file,
      patch,
    ]),
  );
  return `<ul class="list">${filesChanged
    .map((file) => {
      const patch = patchesByFile.get(file);
      return `<li><span>${escapeHtml(file)}</span>${
        patch
          ? `<small>+${escapeHtml(patch.linesAdded)} / -${escapeHtml(patch.linesDeleted)} ${escapeHtml(patch.description)}</small>`
          : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

function renderJudge(result: TracePilotJudgeResult | undefined): string {
  if (!result) {
    return empty('No judge result attached.');
  }
  if (result.mode === 'unavailable') {
    return `<p class="large">${escapeHtml(result.summary)}</p><p class="subtle">${escapeHtml(result.unavailableReason)}</p>`;
  }
  return `<p class="score">${Math.round(result.overallScore * 100)}%</p>
  <p class="subtle">${escapeHtml(result.summary)}</p>
  ${result.model ? `<p class="subtle">Model: ${escapeHtml(result.model)}</p>` : ''}
  <ul class="list compact">${result.criteria
    .map(
      (criterion) =>
        `<li><span class="pill pass">${Math.round(criterion.score * 100)}%</span>${escapeHtml(criterion.id)}<small>${escapeHtml(criterion.rationale)}</small></li>`,
    )
    .join('')}</ul>`;
}

function renderSafety(input: DashboardInput): string {
  const risk = input.repairArtifact?.safety.risk;
  const redactionEval = input.evalReport?.results.find(
    (result) => result.id === 'secret_redaction_success',
  );
  return `<dl class="facts">
    <div><dt>Risk</dt><dd>${escapeHtml(risk?.level ?? input.judgeInput?.safety.riskLevel ?? 'unknown')}</dd></div>
    <div><dt>Approval</dt><dd>${escapeHtml(String(risk?.requiresApproval ?? input.judgeInput?.safety.requiresApproval ?? 'unknown'))}</dd></div>
    <div><dt>Rollback</dt><dd>${escapeHtml(String(risk?.rollbackRequired ?? input.judgeInput?.safety.rollbackRequired ?? 'unknown'))}</dd></div>
    <div><dt>Redaction</dt><dd>${escapeHtml(redactionEval?.status ?? 'unknown')}</dd></div>
  </dl>`;
}

function renderEvidenceDetails(input: DashboardInput): string {
  const report = input.report;
  const rows = [
    ['Model', stringValue(getRecord(report['agent'])?.['model']) ?? 'unknown'],
    [
      'Repair Phase',
      input.repairArtifact?.phase ??
        input.judgeInput?.repair.phase ??
        'unknown',
    ],
    [
      'Root Cause',
      input.repairArtifact?.failure.rootCause ??
        input.judgeInput?.repair.rootCause ??
        'unknown',
    ],
    [
      'Confidence',
      input.repairArtifact?.confidence.score === undefined
        ? 'unknown'
        : `${Math.round(input.repairArtifact.confidence.score * 100)}%`,
    ],
    [
      'Phoenix Traces',
      String(
        input.repairArtifact?.phoenix.tracesConsulted.length ??
          input.judgeInput?.repair.phoenixTraceCount ??
          0,
      ),
    ],
  ];
  return `<dl class="facts wide">${rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join('')}</dl>`;
}

function safetyStatus(input: DashboardInput): string {
  const risk =
    input.repairArtifact?.safety.risk.level ??
    input.judgeInput?.safety.riskLevel;
  return risk ?? 'unknown';
}

function filesChangedText(input: DashboardInput): number {
  return (
    getStringArray(getRecord(input.report['repair'])?.['changedFiles'])
      ?.length ??
    input.repairArtifact?.repair.filesModified.length ??
    input.judgeInput?.repair.filesModified.length ??
    0
  );
}

function statusTitle(ok: boolean, strictLiveProof: boolean): string {
  if (ok && strictLiveProof) {
    return 'Repair Proven With Strict Live Evidence';
  }
  if (ok) {
    return 'Repair Evidence Ready For Review';
  }
  return 'Repair Evidence Needs Attention';
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function empty(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

function css(): string {
  return `
:root { color-scheme: light; --bg: #f6f7f9; --ink: #172026; --muted: #68727d; --line: #d8dde3; --ok: #16794c; --warn: #a36500; --fail: #b42318; --panel: #ffffff; --accent: #215f9a; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
.shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 40px; }
.hero { min-height: 210px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 34px; color: white; background: linear-gradient(135deg, #17324d, #215f9a 56%, #17745b); border-radius: 8px; }
.hero h1 { margin: 0; max-width: 780px; font-size: 42px; line-height: 1.05; letter-spacing: 0; }
.eyebrow { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .12em; opacity: .82; }
.subtle { color: var(--muted); line-height: 1.55; }
.hero .subtle { color: rgba(255,255,255,.82); max-width: 760px; }
.status { min-width: 112px; height: 112px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.38); border-radius: 56px; font-weight: 800; }
.status.ok { background: rgba(22,121,76,.5); }
.status.fail { background: rgba(180,35,24,.5); }
.metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.metric, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 1px 2px rgba(23,32,38,.05); }
.metric { min-height: 92px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between; }
.metric span, .section-head span, dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.metric strong { font-size: 20px; line-height: 1.15; overflow-wrap: anywhere; }
.panel { padding: 18px; margin-top: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
h2 { margin: 0; font-size: 18px; }
.timeline { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.step { min-height: 164px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfd; }
.step h3 { margin: 12px 0 8px; font-size: 15px; }
.step p { margin: 0; color: var(--muted); line-height: 1.45; overflow-wrap: anywhere; }
.dot { width: 22px; height: 22px; border-radius: 50%; }
.step.pass .dot, .pill.pass { background: var(--ok); }
.step.warn .dot, .pill.warn, .pill.skipped { background: var(--warn); }
.step.fail .dot, .pill.fail { background: var(--fail); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.list li { min-height: 40px; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: #fbfcfd; overflow-wrap: anywhere; }
.list.compact li { align-items: flex-start; flex-direction: column; gap: 6px; }
.list small { color: var(--muted); line-height: 1.4; }
.pill { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 9px; border-radius: 999px; color: white; font-size: 12px; font-weight: 700; }
.facts { display: grid; gap: 10px; margin: 0; }
.facts.wide { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.facts div { padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: #fbfcfd; }
dt { margin-bottom: 6px; }
dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 18px; border: 1px dashed var(--line); border-radius: 6px; margin: 0; }
.large { font-size: 18px; font-weight: 700; margin: 0 0 8px; }
.score { font-size: 44px; line-height: 1; margin: 0 0 12px; font-weight: 800; color: var(--accent); }
@media (max-width: 960px) { .metrics, .timeline, .grid, .facts.wide { grid-template-columns: 1fr 1fr; } .hero { align-items: flex-start; flex-direction: column; } }
@media (max-width: 640px) { .shell { width: min(100% - 20px, 1180px); padding-top: 10px; } .hero { padding: 24px; } .hero h1 { font-size: 30px; } .metrics, .timeline, .grid, .facts.wide { grid-template-columns: 1fr; } .status { width: 96px; height: 96px; min-width: 96px; } }
`;
}

function stringValue(value: unknown, fallback?: string): string | undefined {
  return typeof value === 'string' ? sanitize(value) : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function getStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map(sanitize)
    : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeHtml(value: string | number): string {
  return sanitize(String(value))
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitize(value: string): string {
  return redactSensitiveText(value).value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
