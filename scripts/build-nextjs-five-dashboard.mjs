#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const phaseRoot = '.ai-logs/tracepilot-independent-eval/phase3-nextjs-five';
const reportPath = (await readFile(path.join(phaseRoot, 'latest-agent-comparison.txt'), 'utf8')).trim();
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const output = path.resolve(
  process.argv[2] ?? '.ai-logs/tracepilot-independent-eval/phase3-dashboard/index.html',
);

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, render(report, reportPath), 'utf8');
console.log(`TracePilot five-issue dashboard: ${output}`);

function render(data, sourcePath) {
  const blind = data.summary.byArm.blind ?? { total: 0, fixed: 0 };
  const tracepilot = data.summary.byArm.tracepilot ?? { total: 0, fixed: 0 };
  const grouped = groupByBenchmark(data.results);
  const traceWins = data.summary.advantages.filter((item) => item.outcome === 'tracepilot_only').length;
  const blindWins = data.summary.advantages.filter((item) => item.outcome === 'blind_only').length;
  const headline =
    tracepilot.fixed > blind.fixed
      ? 'TracePilot wins on this closed-issue replay'
      : tracepilot.fixed === blind.fixed
        ? 'TracePilot ties Gemini CLI on this replay'
        : 'Gemini CLI wins on this replay';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TracePilot Five-Issue Next.js Benchmark</title>
  <style>${css()}</style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">TracePilot Hackathon Evidence</p>
        <h1>${escapeHtml(headline)}</h1>
        <p class="lede">Five closed Next.js issues were selected, cloned, reproduced, and replayed against the same Gemini CLI model. The treatment arm keeps Phoenix/MCP trace history; the blind arm has that evidence removed.</p>
      </div>
      <div class="scoreboard">
        ${score('Gemini CLI', blind.fixed, blind.total, '')}
        ${score('TracePilot + Gemini', tracepilot.fixed, tracepilot.total, 'highlight')}
      </div>
    </section>

    <section class="band issue-band">
      <div class="section-copy">
        <p class="eyebrow">Issue Intake</p>
        <h2>Closed Vercel/Next.js repros</h2>
        <p>${data.reproducedIssueCount}/${data.selectedIssueCount} candidates reproduced locally and entered scoring. Non-reproducing candidates stay visible as evidence, not hidden.</p>
      </div>
      <div class="issue-grid">
        ${data.issues.map(renderIssue).join('\n')}
      </div>
    </section>

    <section class="band">
      <div class="section-title">
        <div>
          <p class="eyebrow">Benchmark Result</p>
          <h2>Same model, same verifier, different evidence</h2>
        </div>
        <div class="pill-row">
          <span>TracePilot-only fixes: ${traceWins}</span>
          <span>Gemini-only fixes: ${blindWins}</span>
        </div>
      </div>
      <div class="result-grid">
        ${grouped.map(([id, results]) => renderResultCard(id, results)).join('\n')}
      </div>
    </section>

    <section class="band evidence-band">
      <div class="section-copy">
        <p class="eyebrow">Phoenix / MCP Proof</p>
        <h2>Trace sessions were created</h2>
        <p>TracePilot arms carry Phoenix access and session identifiers, which can be opened in Arize Phoenix during the video.</p>
      </div>
      <div class="session-grid">
        ${data.results.filter((result) => result.arm === 'tracepilot').map(renderSession).join('\n')}
      </div>
    </section>

    <section class="band">
      <div class="section-title">
        <div>
          <p class="eyebrow">Terminal Summary</p>
          <h2>Start/end times and verifier exits</h2>
        </div>
      </div>
      <pre class="terminal">${escapeHtml(terminalSummary(data, sourcePath))}</pre>
      <details>
        <summary>More info</summary>
        <div class="details-grid">
          ${data.results.map(renderMoreInfo).join('\n')}
        </div>
      </details>
    </section>

    <section class="band conclusion">
      <p class="eyebrow">Evidence-Based Summary</p>
      <h2>${escapeHtml(conclusionTitle(data))}</h2>
      <p>${escapeHtml(conclusionText(data))}</p>
    </section>
  </main>
</body>
</html>`;
}

function score(label, fixed, total, className) {
  return `<article class="score ${className}">
    <span>${escapeHtml(label)}</span>
    <strong>${fixed}/${total}</strong>
    <small>verified fixes</small>
  </article>`;
}

function renderIssue(issue) {
  return `<article class="issue ${issue.preparation.reproduced ? 'ok' : 'skip'}">
    <b>${escapeHtml(issue.id)}</b>
    <span>${escapeHtml(issue.title)}</span>
    <small>${issue.preparation.reproduced ? 'reproduced' : 'not scored'} · ${escapeHtml(issue.verifierCommand)}</small>
  </article>`;
}

function renderResultCard(id, results) {
  const blind = results.find((item) => item.arm === 'blind');
  const tracepilot = results.find((item) => item.arm === 'tracepilot');
  return `<article class="result">
    <header>
      <b>${escapeHtml(id)}</b>
      <span>${escapeHtml(outcome(blind, tracepilot))}</span>
    </header>
    <div class="arms">
      ${renderArm('Gemini CLI', blind)}
      ${renderArm('TracePilot', tracepilot)}
    </div>
  </article>`;
}

function renderArm(label, result) {
  if (!result) return '<div class="arm muted"><span>not run</span></div>';
  return `<div class="arm ${result.fixed ? 'pass' : 'fail'}">
    <span>${escapeHtml(label)}</span>
    <b>${result.fixed ? 'fixed' : 'missed'}</b>
    <small>${time(result.timeline.startedAt)} -> ${time(result.timeline.endedAt)} · ${Math.round(result.timeline.durationMs / 1000)}s</small>
  </div>`;
}

function renderSession(result) {
  return `<article class="session">
    <b>${escapeHtml(result.benchmarkId)}</b>
    <span>${escapeHtml(result.sessionId)}</span>
    <small>${result.metrics.phoenixEvidenceMentioned ? 'trace marker in stream' : 'session id recorded'}</small>
  </article>`;
}

function renderMoreInfo(result) {
  return `<article class="more-card">
    <h3>${escapeHtml(result.benchmarkId)} · ${escapeHtml(result.arm)}</h3>
    <dl>
      <dt>Fixed</dt><dd>${String(result.fixed)}</dd>
      <dt>Time</dt><dd>${escapeHtml(result.timeline.startedAt)} -> ${escapeHtml(result.timeline.endedAt)}</dd>
      <dt>Verifier</dt><dd>${escapeHtml(result.before.exitCode)} -> ${escapeHtml(result.after.exitCode)}</dd>
      <dt>Changed</dt><dd>${escapeHtml(result.changedFiles.join(', ') || 'no patch')}</dd>
      <dt>Summary</dt><dd>${escapeHtml(result.summary)}</dd>
    </dl>
    <pre>${escapeHtml(snippet(result.agent.outputPreview))}</pre>
  </article>`;
}

function terminalSummary(data, sourcePath) {
  const lines = [
    '> node scripts\\run-nextjs-five-issue-comparison.mjs',
    `COMPARISON_REPORT: ${sourcePath}`,
    `model: ${data.model}`,
    '',
    'benchmark      arm          fixed   verifier   start -> end',
  ];
  for (const result of data.results) {
    lines.push(
      `${result.benchmarkId.padEnd(14)} ${result.arm.padEnd(12)} ${String(result.fixed).padEnd(7)} ${result.before.exitCode} -> ${result.after.exitCode}   ${time(result.timeline.startedAt)} -> ${time(result.timeline.endedAt)}`,
    );
  }
  return lines.join('\n');
}

function conclusionTitle(data) {
  const blind = data.summary.byArm.blind?.fixed ?? 0;
  const tracepilot = data.summary.byArm.tracepilot?.fixed ?? 0;
  if (tracepilot > blind) return 'Trace history improved the verified repair score';
  if (tracepilot === blind) return 'Trace history matched the baseline in verified score';
  return 'Trace history did not improve this replay';
}

function conclusionText(data) {
  const blind = data.summary.byArm.blind ?? { fixed: 0, total: 0 };
  const tracepilot = data.summary.byArm.tracepilot ?? { fixed: 0, total: 0 };
  const markers = tracepilot.phoenixEvidenceMentioned ?? 0;
  return `Gemini CLI fixed ${blind.fixed}/${blind.total}; TracePilot fixed ${tracepilot.fixed}/${tracepilot.total}. TracePilot sessions kept Phoenix/MCP evidence and ${markers} captured streams mentioned trace/session evidence. The claim is intentionally bounded to this run and the external verifiers shown above.`;
}

function outcome(blind, tracepilot) {
  if (!blind?.fixed && tracepilot?.fixed) return 'TracePilot advantage';
  if (blind?.fixed && tracepilot?.fixed) return 'both fixed';
  if (blind?.fixed && !tracepilot?.fixed) return 'Gemini-only';
  return 'both missed';
}

function groupByBenchmark(results) {
  const map = new Map();
  for (const result of results) map.set(result.benchmarkId, [...(map.get(result.benchmarkId) ?? []), result]);
  return [...map.entries()];
}

function snippet(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 9)
    .join('\n')
    .slice(0, 1300);
}

function time(value) {
  return new Date(value).toLocaleTimeString('en-US', { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function css() {
  return `
    :root {
      color-scheme: dark;
      --bg: #08110f;
      --panel: #101816;
      --panel2: #14211d;
      --line: #31413c;
      --text: #f4fbf8;
      --muted: #a7b7b2;
      --good: #43dda0;
      --blue: #72c7ff;
      --bad: #ff7a70;
      --gold: #ffd166;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1240px; margin: 0 auto; padding: 22px; }
    .hero { min-height: 44vh; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr); gap: 22px; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 22px; }
    .eyebrow { margin: 0 0 8px; color: var(--good); text-transform: uppercase; font-size: 12px; font-weight: 850; letter-spacing: 0; }
    h1 { margin: 0; max-width: 820px; font-size: 52px; line-height: 1.03; letter-spacing: 0; }
    h2 { margin: 0; font-size: 24px; letter-spacing: 0; }
    .lede, .section-copy p, .conclusion p { color: var(--muted); font-size: 17px; line-height: 1.5; max-width: 820px; }
    .scoreboard { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .score, .band, .issue, .result, .arm, .session, .more-card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .score { min-height: 178px; padding: 18px; display: flex; flex-direction: column; justify-content: space-between; }
    .score.highlight { border-color: rgba(67, 221, 160, .8); background: #10231c; }
    .score span, .arm span { color: var(--muted); font-size: 13px; }
    .score strong { font-size: 76px; line-height: 1; }
    .score small { color: var(--muted); }
    .band { margin: 18px 0; padding: 18px; }
    .issue-band, .evidence-band { display: grid; grid-template-columns: 300px 1fr; gap: 18px; }
    .issue-grid, .result-grid, .session-grid, .details-grid { display: grid; gap: 12px; }
    .issue-grid { grid-template-columns: repeat(3, 1fr); }
    .issue { padding: 14px; background: var(--panel2); min-height: 126px; }
    .issue b, .issue span, .issue small { display: block; }
    .issue b { color: var(--blue); margin-bottom: 8px; }
    .issue span { font-weight: 780; }
    .issue small { color: var(--muted); margin-top: 8px; line-height: 1.35; }
    .issue.skip { opacity: .7; }
    .section-title { display: flex; justify-content: space-between; align-items: end; gap: 18px; margin-bottom: 14px; }
    .pill-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill-row span { border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); }
    .result-grid { grid-template-columns: repeat(3, 1fr); }
    .result { padding: 14px; background: var(--panel2); }
    .result header { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
    .result header b { color: var(--blue); }
    .result header span { color: var(--good); font-weight: 850; text-align: right; }
    .arms { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .arm { min-height: 108px; padding: 12px; background: #09100e; }
    .arm b { display: block; margin: 9px 0; font-size: 27px; color: var(--bad); }
    .arm.pass b { color: var(--good); }
    .arm small { color: var(--muted); line-height: 1.35; }
    .session-grid { grid-template-columns: repeat(3, 1fr); }
    .session { padding: 14px; background: var(--panel2); min-width: 0; }
    .session b, .session span, .session small { display: block; }
    .session span { margin: 8px 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .session small { color: var(--good); }
    .terminal, .more-card pre { margin: 0; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: #050807; color: #dce7e3; overflow: auto; font-size: 13px; line-height: 1.45; }
    details { margin-top: 14px; }
    summary { cursor: pointer; display: inline-flex; padding: 10px 14px; border-radius: 8px; background: var(--good); color: #04100c; font-weight: 900; }
    .details-grid { grid-template-columns: repeat(2, 1fr); margin-top: 14px; }
    .more-card { padding: 14px; background: var(--panel2); }
    .more-card h3 { margin: 0 0 12px; color: var(--blue); }
    dl { display: grid; grid-template-columns: 82px 1fr; gap: 6px 10px; margin: 0 0 12px; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 940px) {
      main { padding: 14px; }
      .hero, .issue-band, .evidence-band, .issue-grid, .result-grid, .session-grid, .details-grid { grid-template-columns: 1fr; }
      h1 { font-size: 36px; }
    }
  `;
}
