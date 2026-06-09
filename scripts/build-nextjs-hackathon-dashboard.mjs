#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const phaseRoot = '.ai-logs/tracepilot-independent-eval/phase2-nextjs';
const reportPath = (
  await readFile(path.join(phaseRoot, 'latest-agent-comparison.txt'), 'utf8')
).trim();
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const manifest = JSON.parse(
  await readFile(path.join(phaseRoot, 'benchmark-manifest.json'), 'utf8'),
);
const output = path.resolve(
  process.argv[2] ??
    '.ai-logs/tracepilot-independent-eval/hackathon-dashboard/index.html',
);

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, render(report, manifest, reportPath), 'utf8');
console.log(`TracePilot hackathon dashboard: ${output}`);

function render(data, manifestData, sourcePath) {
  const testedIds = [...new Set(data.results.map((result) => result.benchmarkId))];
  const issueDetails = testedIds.map((id) => {
    const manifestId = id.replace('next-', 'next-');
    return manifestData.benchmarks.find((issue) => issue.id === manifestId);
  });
  const blind = data.summary.byArm.blind;
  const tracepilot = data.summary.byArm.tracepilot;
  const grouped = groupByBenchmark(data.results);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TracePilot Next.js Closed-Issue Benchmark</title>
  <style>${css()}</style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">TracePilot Hackathon Demo</p>
        <h1>Trace history helps Gemini repair closed Next.js issues</h1>
        <p class="lede">We replayed reproduced, closed Next.js bugs with the same model, prompt budget, and external verifier. The only treatment difference: the TracePilot arm keeps Phoenix/MCP trace evidence and session history.</p>
      </div>
      <div class="score-card">
        <div><span>Gemini CLI</span><strong>${blind.fixed}/${blind.total}</strong><small>fixed</small></div>
        <div class="winner"><span>TracePilot + Gemini</span><strong>${tracepilot.fixed}/${tracepilot.total}</strong><small>fixed</small></div>
      </div>
    </section>

    <section class="band intro">
      <div>
        <p class="eyebrow">Issue Set</p>
        <h2>Real closed issues, real failing verifiers</h2>
      </div>
      <div class="issue-list">
        ${issueDetails.map(renderIssueIntro).join('\n')}
      </div>
    </section>

    <section class="band">
      <div class="section-title">
        <p class="eyebrow">Final Result</p>
        <h2>Blind vs TracePilot</h2>
      </div>
      <div class="cards">
        ${grouped.map(([id, results]) => renderIssueCard(id, results)).join('\n')}
      </div>
    </section>

    <section class="band evidence">
      <div>
        <p class="eyebrow">Arize / Phoenix Evidence</p>
        <h2>Trace-assisted sessions are visible</h2>
        <p>Each TracePilot arm has a session id and Phoenix/MCP evidence marker in the captured agent stream.</p>
      </div>
      <div class="session-grid">
        ${data.results
          .filter((result) => result.arm === 'tracepilot')
          .map(renderSession)
          .join('\n')}
      </div>
    </section>

    <section class="band terminal">
      <div class="section-title">
        <p class="eyebrow">Terminal Proof</p>
        <h2>Live command and verifier exits</h2>
      </div>
      <div class="terminal-box">
        <pre>${escapeHtml(terminalSummary(data, sourcePath))}</pre>
      </div>
      <details>
        <summary>More info: raw Gemini snippets and verifier output</summary>
        <div class="details-grid">
          ${data.results.map(renderMoreInfo).join('\n')}
        </div>
      </details>
    </section>
  </main>
</body>
</html>`;
}

function renderIssueIntro(issue) {
  if (!issue) return '';
  return `<article class="issue-intro">
    <b>${escapeHtml(issue.id)}</b>
    <span>${escapeHtml(issue.title)}</span>
    <small>${escapeHtml(issue.category)}</small>
  </article>`;
}

function renderIssueCard(id, results) {
  const blind = results.find((result) => result.arm === 'blind');
  const tracepilot = results.find((result) => result.arm === 'tracepilot');
  return `<article class="result-card">
    <header>
      <b>${escapeHtml(id)}</b>
      <span>${escapeHtml(outcome(blind, tracepilot))}</span>
    </header>
    <div class="compare">
      ${renderArm('Gemini CLI', blind)}
      ${renderArm('TracePilot', tracepilot)}
    </div>
  </article>`;
}

function renderArm(label, result) {
  return `<div class="arm ${result?.fixed ? 'pass' : 'fail'}">
    <span>${escapeHtml(label)}</span>
    <b>${result?.fixed ? 'fixed' : 'missed'}</b>
    <small>verifier ${result?.before.exitCode ?? '?'} -> ${result?.after.exitCode ?? '?'} · ${Math.round((result?.agent.durationMs ?? 0) / 1000)}s</small>
  </div>`;
}

function renderSession(result) {
  return `<article class="session">
    <b>${escapeHtml(result.benchmarkId)}</b>
    <span>${escapeHtml(result.sessionId)}</span>
    <small>${result.metrics.phoenixEvidenceMentioned ? 'Phoenix/MCP evidence marker present' : 'No marker found'}</small>
  </article>`;
}

function renderMoreInfo(result) {
  return `<article class="more-card">
    <h3>${escapeHtml(result.benchmarkId)} · ${escapeHtml(result.arm)}</h3>
    <dl>
      <dt>Fixed</dt><dd>${String(result.fixed)}</dd>
      <dt>Verifier</dt><dd>${escapeHtml(result.verifierCommand)}</dd>
      <dt>Changed</dt><dd>${escapeHtml(result.changedFiles.join(', ') || 'no patch')}</dd>
    </dl>
    <pre>${escapeHtml(snippet(result.agent.outputPreview))}</pre>
  </article>`;
}

function terminalSummary(data, sourcePath) {
  const lines = [
    '> node .ai-logs\\tracepilot-independent-eval\\phase2-nextjs\\run-agent-comparison.mjs',
    `COMPARISON_REPORT: ${sourcePath}`,
    '',
    'benchmark      arm          fixed   verifier',
  ];
  for (const result of data.results) {
    lines.push(
      `${result.benchmarkId.padEnd(14)} ${result.arm.padEnd(12)} ${String(
        result.fixed,
      ).padEnd(7)} ${result.before.exitCode} -> ${result.after.exitCode}`,
    );
  }
  return lines.join('\n');
}

function outcome(blind, tracepilot) {
  if (!blind?.fixed && tracepilot?.fixed) return 'TracePilot advantage';
  if (blind?.fixed && tracepilot?.fixed) return 'both fixed';
  if (!blind?.fixed && !tracepilot?.fixed) return 'both missed';
  return 'blind only';
}

function groupByBenchmark(results) {
  const map = new Map();
  for (const result of results) {
    map.set(result.benchmarkId, [...(map.get(result.benchmarkId) ?? []), result]);
  }
  return [...map.entries()];
}

function snippet(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 10)
    .join('\n')
    .slice(0, 1400);
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
      --bg: #070b0a;
      --panel: #101615;
      --panel-2: #151f1c;
      --line: #2c3835;
      --text: #f6fbf9;
      --muted: #9fb0ab;
      --green: #4de0a4;
      --cyan: #67c8ff;
      --red: #ff756c;
      --amber: #ffc45f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1220px; margin: 0 auto; padding: 24px; }
    .hero {
      min-height: 46vh;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
      gap: 24px;
      align-items: center;
      padding: 22px 0 26px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow { margin: 0 0 8px; color: var(--green); text-transform: uppercase; letter-spacing: 0; font-size: 12px; font-weight: 800; }
    h1 { margin: 0; max-width: 820px; font-size: 54px; line-height: 1.02; letter-spacing: 0; }
    h2 { margin: 0; font-size: 25px; letter-spacing: 0; }
    .lede { max-width: 780px; color: var(--muted); font-size: 18px; line-height: 1.55; }
    .score-card { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .score-card div, .band, .issue-intro, .result-card, .arm, .session, .more-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .score-card div { min-height: 190px; padding: 18px; display: flex; flex-direction: column; justify-content: space-between; }
    .score-card .winner { border-color: rgba(77, 224, 164, .8); background: #10201a; }
    .score-card span, .arm span { color: var(--muted); font-size: 13px; }
    .score-card strong { font-size: 80px; line-height: 1; }
    .score-card small { color: var(--muted); }
    .band { margin: 18px 0; padding: 18px; }
    .intro { display: grid; grid-template-columns: 280px 1fr; gap: 18px; align-items: start; }
    .issue-list, .cards, .session-grid, .details-grid { display: grid; gap: 12px; }
    .issue-list { grid-template-columns: repeat(3, 1fr); }
    .issue-intro { padding: 14px; min-height: 120px; background: var(--panel-2); }
    .issue-intro b, .issue-intro span, .issue-intro small { display: block; }
    .issue-intro b { color: var(--cyan); margin-bottom: 8px; }
    .issue-intro span { font-weight: 750; }
    .issue-intro small { color: var(--muted); margin-top: 8px; line-height: 1.35; }
    .section-title { display: flex; align-items: end; justify-content: space-between; margin-bottom: 14px; }
    .cards { grid-template-columns: repeat(3, 1fr); }
    .result-card { padding: 14px; background: var(--panel-2); }
    .result-card header { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
    .result-card header b { color: var(--cyan); }
    .result-card header span { color: var(--green); font-weight: 800; text-align: right; }
    .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .arm { padding: 12px; min-height: 112px; background: #0b100f; }
    .arm b { display: block; margin: 10px 0; font-size: 28px; color: var(--red); }
    .arm.pass b { color: var(--green); }
    .arm small { color: var(--muted); line-height: 1.35; }
    .evidence { display: grid; grid-template-columns: 320px 1fr; gap: 18px; }
    .evidence p { color: var(--muted); line-height: 1.5; }
    .session-grid { grid-template-columns: repeat(3, 1fr); }
    .session { padding: 14px; background: var(--panel-2); min-width: 0; }
    .session b, .session span, .session small { display: block; }
    .session span { margin: 8px 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .session small { color: var(--green); }
    .terminal-box pre, .more-card pre {
      margin: 0;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #050706;
      color: #d9e4e0;
      overflow: auto;
      font-size: 13px;
      line-height: 1.45;
    }
    details { margin-top: 14px; }
    summary {
      cursor: pointer;
      display: inline-flex;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--green);
      color: #04100c;
      font-weight: 850;
    }
    .details-grid { grid-template-columns: repeat(2, 1fr); margin-top: 14px; }
    .more-card { padding: 14px; background: var(--panel-2); }
    .more-card h3 { margin: 0 0 12px; color: var(--cyan); }
    dl { display: grid; grid-template-columns: 88px 1fr; gap: 6px 10px; margin: 0 0 12px; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 900px) {
      main { padding: 14px; }
      .hero, .intro, .evidence, .issue-list, .cards, .session-grid, .details-grid { grid-template-columns: 1fr; }
      h1 { font-size: 38px; }
    }
  `;
}
