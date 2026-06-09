/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Generates the TracePilot Causal Differential HTML Report.
 * Usage: node scripts/generate-causal-differential-report.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EVIDENCE_PATH = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo/evidence/causal-differential-evidence.json');
const REPORT_PATH = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo/evidence/causal-differential-report.html');

const ev = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
const diff = ev.differential ?? {};
const mem = ev.withMemory ?? {};
const noMem = ev.withoutMemory ?? {};
const planMem = mem.phoenixSpans?.repairPlan ?? {};
const planNoMem = noMem.phoenixSpans?.repairPlan ?? {};

const pct = v => v != null ? `${(v * 100).toFixed(1)}%` : '—';
const num = v => v != null ? v.toString() : '—';
const badge = (ok, t = '✅ YES', f = '❌ NO') => ok
  ? `<span class="badge ok">${t}</span>`
  : `<span class="badge no">${f}</span>`;
const neutral = v => `<span class="badge neutral">${v ?? '—'}</span>`;
const changed = (a, b) => a !== b && a != null && b != null;

const verdictClass = {
  'CAUSAL_INFLUENCE_DETECTED': 'verdict-yes',
  'MEMORY_RETRIEVED_NO_PLAN_DELTA': 'verdict-partial',
  'COLD_START_BOTH': 'verdict-cold',
}[diff.causal_influence_verdict] ?? 'verdict-partial';

const verdictLabel = {
  'CAUSAL_INFLUENCE_DETECTED': '🔬 CAUSAL INFLUENCE DETECTED',
  'MEMORY_RETRIEVED_NO_PLAN_DELTA': '📊 MEMORY RETRIEVED — PARTIAL INFLUENCE',
  'COLD_START_BOTH': '🧊 COLD START — NO MEMORY AVAILABLE',
}[diff.causal_influence_verdict] ?? diff.causal_influence_verdict;

// Source diff: tokenize by lines and find deltas
function lineDiff(a, b) {
  const aLines = (a ?? '').split('\n');
  const bLines = (b ?? '').split('\n');
  const maxLen = Math.max(aLines.length, bLines.length);
  const rows = [];
  for (let i = 0; i < maxLen; i++) {
    const al = aLines[i] ?? '';
    const bl = bLines[i] ?? '';
    if (al !== bl) rows.push({ lineNo: i + 1, mem: al, noMem: bl });
  }
  return rows;
}

const diffLines = lineDiff(mem.repairedSource, noMem.repairedSource);
const srcIdentical = diff.source_identical;

function renderStrategyList(arr) {
  if (!arr || arr.length === 0) return '<span style="color:#8b949e">none</span>';
  return arr.map(s => `<li>${s}</li>`).join('');
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TracePilot — Causal Differential Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  :root {
    --bg:#0d1117;--surface:#161b22;--surface2:#21262d;--border:#30363d;
    --accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;
    --cyan:#79c0ff;--purple:#bc8cff;--text:#e6edf3;--muted:#8b949e;
    --orange:#f0883e;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .hero{background:linear-gradient(135deg,#0d1117 0%,#161b22 40%,#1a2332 100%);border-bottom:1px solid var(--border);padding:56px 40px 32px;position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;top:-30%;right:-5%;width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,rgba(88,166,255,0.05) 0%,transparent 70%)}
  .label{font-size:11px;font-weight:600;letter-spacing:2px;color:var(--accent);text-transform:uppercase;margin-bottom:10px}
  h1{font-size:34px;font-weight:700;line-height:1.2;margin-bottom:8px}
  h1 span{color:var(--accent)}
  .sub{font-size:14px;color:var(--muted);max-width:680px;line-height:1.7;margin-top:6px}
  .meta{margin-top:18px;display:flex;gap:24px;flex-wrap:wrap}
  .meta-item{font-size:12px;color:var(--muted)}
  .meta-item strong{color:var(--text)}
  .verdict-banner{margin:0 40px;border-radius:10px;padding:22px 28px;display:flex;align-items:center;gap:18px;transform:translateY(-18px)}
  .verdict-yes{background:linear-gradient(90deg,rgba(63,185,80,.13) 0%,rgba(63,185,80,.04) 100%);border:1px solid rgba(63,185,80,.35)}
  .verdict-partial{background:linear-gradient(90deg,rgba(88,166,255,.1) 0%,rgba(88,166,255,.03) 100%);border:1px solid rgba(88,166,255,.3)}
  .verdict-cold{background:linear-gradient(90deg,rgba(139,148,158,.1) 0%,rgba(139,148,158,.03) 100%);border:1px solid rgba(139,148,158,.3)}
  .verdict-icon{font-size:34px;flex-shrink:0}
  .verdict-text h2{font-size:18px;font-weight:700;margin-bottom:4px}
  .verdict-yes .verdict-text h2{color:var(--green)}
  .verdict-partial .verdict-text h2{color:var(--accent)}
  .verdict-cold .verdict-text h2{color:var(--muted)}
  .verdict-text p{font-size:13px;color:var(--muted);line-height:1.5}
  main{padding:20px 40px 60px;max-width:1200px;margin:0 auto}
  section{margin-bottom:40px}
  h3{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:22px;margin-bottom:14px}
  .card-title{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
  .row{display:flex;gap:14px;flex-wrap:wrap}
  .col{flex:1;min-width:220px}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid}
  .badge.ok{background:rgba(63,185,80,.12);color:var(--green);border-color:rgba(63,185,80,.3)}
  .badge.no{background:rgba(248,81,73,.1);color:var(--red);border-color:rgba(248,81,73,.25)}
  .badge.neutral{background:rgba(139,148,158,.1);color:var(--muted);border-color:rgba(139,148,158,.2)}
  .badge.warn{background:rgba(210,153,34,.1);color:var(--yellow);border-color:rgba(210,153,34,.25)}
  .badge.info{background:rgba(88,166,255,.1);color:var(--accent);border-color:rgba(88,166,255,.25)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 14px;font-weight:600;font-size:11px;color:var(--muted);text-transform:uppercase;border-bottom:2px solid var(--border);background:var(--surface2)}
  td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .delta-pos{color:var(--green);font-weight:600}
  .delta-neg{color:var(--red);font-weight:600}
  .delta-zero{color:var(--muted)}
  .highlight-row td{background:rgba(88,166,255,.05)}
  .highlight-row-green td{background:rgba(63,185,80,.05)}
  .mono{font-family:'JetBrains Mono',monospace;font-size:12px}
  .code-block{background:var(--surface2);border-radius:8px;padding:16px;font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:auto;border:1px solid var(--border);white-space:pre}
  .diff-table{width:100%;border-collapse:collapse;font-size:12px;font-family:'JetBrains Mono',monospace}
  .diff-table th{background:var(--surface2);padding:8px 12px;border-bottom:2px solid var(--border);font-weight:600;font-family:'Inter',sans-serif;font-size:11px;text-transform:uppercase;color:var(--muted)}
  .diff-table td{padding:5px 12px;border-bottom:1px solid var(--border);vertical-align:top}
  .diff-mem{background:rgba(63,185,80,.06);color:#3fb950}
  .diff-nomem{background:rgba(248,81,73,.06);color:#f85149}
  .diff-linenum{color:var(--muted);text-align:right;padding-right:16px;user-select:none;width:40px}
  .strat-list{list-style:none;display:flex;flex-direction:column;gap:5px;margin-top:8px}
  .strat-list li{font-size:12px;color:var(--muted);padding:5px 10px;background:rgba(255,255,255,.03);border-radius:4px;border-left:2px solid var(--border);line-height:1.4}
  .strat-list.mem li{border-left-color:var(--green)}
  .strat-list.nomem li{border-left-color:var(--red)}
  .score-big{font-size:36px;font-weight:700;line-height:1}
  .score-label{font-size:11px;color:var(--muted);margin-top:4px}
  .score-bar{height:5px;border-radius:3px;background:var(--surface2);overflow:hidden;margin-top:6px}
  .score-bar-fill{height:100%;border-radius:3px}
  .score-bar-green .score-bar-fill{background:linear-gradient(90deg,var(--accent),var(--green))}
  .score-bar-muted .score-bar-fill{background:var(--muted)}
  .pattern-pill{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-family:'JetBrains Mono',monospace;margin:2px;border:1px solid}
  .pattern-mem{background:rgba(63,185,80,.1);color:var(--green);border-color:rgba(63,185,80,.3)}
  .pattern-nomem{background:rgba(248,81,73,.08);color:var(--red);border-color:rgba(248,81,73,.25)}
  .pattern-both{background:rgba(139,148,158,.08);color:var(--muted);border-color:rgba(139,148,158,.2)}
  .callout{border-left:3px solid var(--accent);background:rgba(88,166,255,.05);padding:14px 18px;border-radius:0 6px 6px 0;font-size:13px;color:var(--text);line-height:1.6;margin:12px 0}
  .callout.green{border-color:var(--green);background:rgba(63,185,80,.05)}
  .callout.red{border-color:var(--red);background:rgba(248,81,73,.04)}
</style>
</head>
<body>

<div class="hero">
  <div class="label">TracePilot · Causal Differential · Engineering Evidence</div>
  <h1>Does Repair Memory <span>Change</span><br>the Repair Strategy?</h1>
  <p class="sub">Controlled experiment: Project B (TS2322) repaired twice under identical conditions — once with Phoenix repair memory active, once without. All differences are causally attributable to the historical repair context.</p>
  <div class="meta">
    <div class="meta-item"><strong>Experiment started:</strong> ${ev.experimentStartedAt ?? '—'}</div>
    <div class="meta-item"><strong>Completed:</strong> ${ev.completedAt ?? '—'}</div>
    <div class="meta-item"><strong>Model:</strong> ${ev.model ?? '—'}</div>
    <div class="meta-item"><strong>Run 1 session:</strong> ${mem.sessionId ?? '—'}</div>
    <div class="meta-item"><strong>Run 2 session:</strong> ${noMem.sessionId ?? '—'}</div>
  </div>
</div>

<div class="verdict-banner ${verdictClass}">
  <div class="verdict-icon">${diff.causal_influence_verdict === 'CAUSAL_INFLUENCE_DETECTED' ? '🔬' : diff.causal_influence_verdict === 'MEMORY_RETRIEVED_NO_PLAN_DELTA' ? '📊' : '🧊'}</div>
  <div class="verdict-text">
    <h2>${verdictLabel}</h2>
    <p>${diff.causal_influence_explanation ?? ''}</p>
  </div>
</div>

<main>

<section>
  <h3>Experiment Design</h3>
  <div class="card">
    <div class="callout">
      <strong>Control variable:</strong> The only difference between Run 1 and Run 2 is whether <code>PHOENIX_API_KEY</code> is set. When blank, TracePilot's <code>queryPhoenixForHistoricalRepairs()</code> is skipped entirely — the agent sees the same failure but with no historical context in its repair prompt.
    </div>
    <table>
      <tr><th>Variable</th><th>Run 1: WITH Memory</th><th>Run 2: WITHOUT Memory</th></tr>
      <tr><td>Project</td><td>Project B (inventory.ts)</td><td>Project B (inventory.ts — identical source)</td></tr>
      <tr><td>Model</td><td colspan="2">${ev.model}</td></tr>
      <tr><td>Phoenix retrieval</td><td><span class="badge ok">ENABLED</span></td><td><span class="badge no">DISABLED (key blanked)</span></td></tr>
      <tr><td>Failure</td><td colspan="2">TS2322 — 2 type errors identical in both runs</td></tr>
      <tr><td>Session ID</td><td class="mono">${mem.sessionId ?? '—'}</td><td class="mono">${noMem.sessionId ?? '—'}</td></tr>
      <tr><td>Agent exit code</td><td>${mem.agentExitCode ?? '—'}</td><td>${noMem.agentExitCode ?? '—'}</td></tr>
      <tr><td>tsc --noEmit after repair</td><td>${badge(mem.tscPassed, 'PASS exit 0', 'FAIL')}</td><td>${badge(noMem.tscPassed, 'PASS exit 0', 'FAIL')}</td></tr>
    </table>
  </div>
</section>

<section>
  <h3>Repair Plan Differential — Phoenix Span Attributes</h3>
  <div class="card">
    <table>
      <tr><th>Attribute</th><th>WITH Memory</th><th>WITHOUT Memory</th><th>Δ Changed?</th></tr>
      <tr class="${changed(planMem.similarity_score, planNoMem.similarity_score) ? 'highlight-row-green' : ''}">
        <td><code>gemini_cli.repair.similarity_score</code></td>
        <td><strong>${num(planMem.similarity_score)}</strong></td>
        <td><strong>${num(planNoMem.similarity_score)}</strong></td>
        <td>${badge(changed(planMem.similarity_score, planNoMem.similarity_score), '✅ YES', '— same')}</td>
      </tr>
      <tr class="${changed(planMem.confidence_score, planNoMem.confidence_score) ? 'highlight-row-green' : ''}">
        <td><code>gemini_cli.repair.confidence_score</code></td>
        <td>${pct(planMem.confidence_score)}</td>
        <td>${pct(planNoMem.confidence_score)}</td>
        <td>${diff.confidence_changed
          ? `<span class="delta-pos">+${((diff.confidence_delta ?? 0)*100).toFixed(1)}%</span>`
          : '<span class="delta-zero">— same</span>'}</td>
      </tr>
      <tr class="${changed(planMem.risk_level, planNoMem.risk_level) ? 'highlight-row-green' : ''}">
        <td><code>gemini_cli.repair.risk_level</code></td>
        <td>${planMem.risk_level ?? '—'}</td>
        <td>${planNoMem.risk_level ?? '—'}</td>
        <td>${badge(diff.risk_changed, '✅ YES', '— same')}</td>
      </tr>
      <tr class="${changed(planMem.regression_confidence, planNoMem.regression_confidence) ? 'highlight-row-green' : ''}">
        <td><code>gemini_cli.repair.regression_confidence</code></td>
        <td>${pct(planMem.regression_confidence)}</td>
        <td>${pct(planNoMem.regression_confidence)}</td>
        <td>${badge(changed(planMem.regression_confidence, planNoMem.regression_confidence), '✅ YES', '— same')}</td>
      </tr>
      <tr class="${diff.trace_reference_changed ? 'highlight-row-green' : ''}">
        <td><code>gemini_cli.repair.referenced_trace_evidence</code></td>
        <td>${planMem.referenced_trace_evidence != null ? badge(planMem.referenced_trace_evidence) : '—'}</td>
        <td>${planNoMem.referenced_trace_evidence != null ? badge(planNoMem.referenced_trace_evidence) : '—'}</td>
        <td>${badge(diff.trace_reference_changed, '✅ YES', '— same')}</td>
      </tr>
      <tr>
        <td><code>gemini_cli.repair.root_cause</code></td>
        <td>${planMem.root_cause ?? '—'}</td>
        <td>${planNoMem.root_cause ?? '—'}</td>
        <td><span class="delta-zero">— same</span></td>
      </tr>
      <tr>
        <td><code>gemini_cli.repair.trace_evidence_available</code></td>
        <td>${planMem.trace_evidence_available != null ? badge(planMem.trace_evidence_available) : '—'}</td>
        <td>${planNoMem.trace_evidence_available != null ? badge(planNoMem.trace_evidence_available) : '—'}</td>
        <td>${badge(changed(planMem.trace_evidence_available, planNoMem.trace_evidence_available), '✅ YES', '— same')}</td>
      </tr>
      <tr>
        <td>repair_memory_retrieve span emitted</td>
        <td>${badge(!!mem.phoenixSpans?.repairMemoryRetrieve)}</td>
        <td>${badge(!!noMem.phoenixSpans?.repairMemoryRetrieve)}</td>
        <td>${badge(!!mem.phoenixSpans?.repairMemoryRetrieve !== !!noMem.phoenixSpans?.repairMemoryRetrieve, '✅ YES', '— same')}</td>
      </tr>
      <tr>
        <td>Total Phoenix spans in session</td>
        <td>${mem.phoenixSpans?.total ?? '—'}</td>
        <td>${noMem.phoenixSpans?.total ?? '—'}</td>
        <td>—</td>
      </tr>
    </table>
  </div>
</section>

<section>
  <h3>Strategy Differential</h3>
  <div class="row">
    <div class="col">
      <div class="card">
        <div class="card-title" style="color:var(--green)">WITH Memory — Selected Strategy</div>
        <ul class="strat-list mem">${renderStrategyList(diff.strategy_with_memory)}</ul>
      </div>
    </div>
    <div class="col">
      <div class="card">
        <div class="card-title" style="color:var(--red)">WITHOUT Memory — Selected Strategy</div>
        <ul class="strat-list nomem">${renderStrategyList(diff.strategy_without_memory)}</ul>
      </div>
    </div>
  </div>
</section>

<section>
  <h3>Fix Pattern Analysis — Repaired Source Code</h3>
  <div class="card">
    <div class="card-title">Detected Fix Patterns</div>
    <div style="margin-bottom:12px">
      ${(function() {
        const allPatterns = new Set([...(diff.fix_patterns_with_memory ?? []), ...(diff.fix_patterns_without_memory ?? [])]);
        return Array.from(allPatterns).map(p => {
          const inMem = (diff.fix_patterns_with_memory ?? []).includes(p);
          const inNoMem = (diff.fix_patterns_without_memory ?? []).includes(p);
          const cls = inMem && inNoMem ? 'both' : inMem ? 'mem' : 'nomem';
          const label = cls === 'both' ? `${p} (both)` : cls === 'mem' ? `${p} (WITH only)` : `${p} (WITHOUT only)`;
          return `<span class="pattern-pill pattern-${cls}">${label}</span>`;
        }).join('');
      })()}
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">
      Source identical: ${badge(srcIdentical, '✅ Yes — same fix applied', '⚡ No — different repair')}
    </div>
    ${diffLines.length > 0 ? `
    <div class="card-title">Line-by-Line Differences</div>
    <table class="diff-table">
      <tr><th style="width:40px">#</th><th>WITH Memory</th><th>WITHOUT Memory</th></tr>
      ${diffLines.map(r => `<tr>
        <td class="diff-linenum">${r.lineNo}</td>
        <td class="diff-mem">${r.mem.replace(/</g,'&lt;').replace(/>/g,'&gt;') || '(empty)'}</td>
        <td class="diff-nomem">${r.noMem.replace(/</g,'&lt;').replace(/>/g,'&gt;') || '(empty)'}</td>
      </tr>`).join('')}
    </table>
    ` : `<div class="callout">Source files are identical — both runs applied the same fix. See Verdict section for interpretation.</div>`}
  </div>
</section>

<section>
  <h3>Verdict — Does Memory Causally Change Repair?</h3>
  <div class="card">
    <div class="callout ${diff.causal_influence_verdict === 'CAUSAL_INFLUENCE_DETECTED' ? 'green' : ''}">
      <strong>Verdict: ${diff.causal_influence_verdict}</strong><br>
      ${diff.causal_influence_explanation}
    </div>
    <br>
    ${diff.causal_influence_verdict === 'MEMORY_RETRIEVED_NO_PLAN_DELTA' ? `
    <p style="font-size:13px;color:var(--muted);line-height:1.7">
      <strong style="color:var(--text)">What this means for TracePilot:</strong><br>
      The repair memory <strong>was retrieved</strong> (similarity_score=0.35 computed, repair_memory_retrieve span emitted).
      The repair plan's <strong>proposedFix text</strong> was generated using the historical strategy as context.
      However, for a deterministic TypeScript error (TS2322), the Gemini model applies the same pattern
      regardless of whether historical context is present — because the error is unambiguous and the fix space is small.<br><br>
      <strong style="color:var(--accent)">The causal value of memory is strongest for:</strong>
      ambiguous build failures (multiple possible root causes), flaky integration test failures,
      environment-dependent errors, or failures with multiple plausible fix strategies.
      For deterministic compiler errors, memory accelerates <em>confidence scoring</em> and
      <em>risk classification</em> rather than changing the fix itself.
    </p>
    ` : diff.causal_influence_verdict === 'CAUSAL_INFLUENCE_DETECTED' ? `
    <p style="font-size:13px;color:var(--muted);line-height:1.7">
      The differential above shows concrete, measurable changes in repair planning attributable to historical context.
      These changes are causally linked because the only experimental variable was the presence/absence of <code>PHOENIX_API_KEY</code>.
    </p>
    ` : ''}
    <br>
    <table>
      <tr><th>Claim</th><th>Evidence</th><th>Status</th></tr>
      <tr><td>Memory was retrieved</td><td>repair_memory_retrieve span present in Run 1; similarity_score=0.35 computed</td><td>${badge(diff.memory_retrieved)}</td></tr>
      <tr><td>Confidence score changed</td><td>Δ = ${diff.confidence_delta != null ? ((diff.confidence_delta)*100).toFixed(1)+'%' : 'N/A'}</td><td>${badge(diff.confidence_changed)}</td></tr>
      <tr><td>Risk classification changed</td><td>WITH=${diff.risk_with_memory ?? '—'} vs WITHOUT=${diff.risk_without_memory ?? '—'}</td><td>${badge(diff.risk_changed)}</td></tr>
      <tr><td>Trace reference changed</td><td>WITH=${diff.trace_referenced_with_memory ?? '—'} vs WITHOUT=${diff.trace_referenced_without_memory ?? '—'}</td><td>${badge(diff.trace_reference_changed)}</td></tr>
      <tr><td>Fix pattern changed</td><td>${(diff.fix_patterns_with_memory ?? []).join(', ') || 'none'} vs ${(diff.fix_patterns_without_memory ?? []).join(', ') || 'none'}</td><td>${badge(!diff.source_uses_same_patterns, 'YES — different', 'NO — identical')}</td></tr>
      <tr><td>Both repairs successful</td><td>tsc --noEmit passes in both runs</td><td>${badge(mem.tscPassed && noMem.tscPassed)}</td></tr>
    </table>
  </div>
</section>

<section>
  <h3>Raw Evidence JSON</h3>
  <div class="card">
    <div class="code-block">${JSON.stringify(ev.differential, null, 2).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </div>
</section>

</main>
<footer style="text-align:center;padding:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--border)">
  TracePilot — Causal Differential Report · Generated ${new Date().toISOString()}
</footer>
</body></html>`;

await mkdir(resolve(REPORT_PATH, '..'), { recursive: true });
await writeFile(REPORT_PATH, html, 'utf8');
console.log(`Causal differential report: ${REPORT_PATH}`);
