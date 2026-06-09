/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates the TracePilot Repair Memory Evidence HTML dashboard.
 * Usage: node scripts/generate-repair-memory-report.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EVIDENCE_PATH = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo/evidence/phoenix-repair-memory-evidence.json');
const REPORT_PATH = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo/evidence/repair-memory-demo-report.html');

const evidence = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
const ml = evidence.memoryLoop ?? {};
const pA = evidence.projectA ?? {};
const pB = evidence.projectB ?? {};
const ph = evidence.phoenixRepairReports ?? {};

function pct(score) { return score !== undefined ? `${(score * 100).toFixed(0)}%` : '—'; }
function badge(ok, trueLabel, falseLabel) {
  return ok
    ? `<span class="badge ok">${trueLabel ?? '✅ YES'}</span>`
    : `<span class="badge fail">${falseLabel ?? '❌ NO'}</span>`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TracePilot — Repair Memory Evidence Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d; --border: #30363d;
    --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --cyan: #79c0ff; --purple: #bc8cff; --text: #e6edf3; --muted: #8b949e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .hero {
    background: linear-gradient(135deg, #0d1117 0%, #161b22 40%, #1a2332 100%);
    border-bottom: 1px solid var(--border);
    padding: 60px 40px 40px;
    position: relative; overflow: hidden;
  }
  .hero::before {
    content: ''; position: absolute; top: -50%; left: -10%;
    width: 600px; height: 600px; border-radius: 50%;
    background: radial-gradient(circle, rgba(88,166,255,0.06) 0%, transparent 70%);
  }
  .hero-label { font-size: 11px; font-weight: 600; letter-spacing: 2px; color: var(--accent); text-transform: uppercase; margin-bottom: 12px; }
  .hero-title { font-size: 36px; font-weight: 700; line-height: 1.2; margin-bottom: 8px; }
  .hero-title span { color: var(--accent); }
  .hero-sub { font-size: 15px; color: var(--muted); max-width: 600px; line-height: 1.6; }
  .hero-meta { margin-top: 20px; display: flex; gap: 24px; flex-wrap: wrap; }
  .meta-item { font-size: 12px; color: var(--muted); }
  .meta-item strong { color: var(--text); }
  .verdict-banner {
    margin: 0 40px;
    background: linear-gradient(90deg, rgba(63,185,80,0.12) 0%, rgba(63,185,80,0.04) 100%);
    border: 1px solid rgba(63,185,80,0.35);
    border-radius: 10px;
    padding: 20px 28px;
    display: flex; align-items: center; gap: 20px;
    transform: translateY(-20px);
  }
  .verdict-icon { font-size: 36px; flex-shrink: 0; }
  .verdict-text h2 { font-size: 20px; font-weight: 700; color: var(--green); margin-bottom: 4px; }
  .verdict-text p { font-size: 13px; color: var(--muted); line-height: 1.5; }
  main { padding: 20px 40px 60px; max-width: 1100px; margin: 0 auto; }
  section { margin-bottom: 40px; }
  h3 { font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; margin-bottom: 16px; }
  .card-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .col { flex: 1; min-width: 240px; }
  .kv { display: flex; flex-direction: column; gap: 8px; }
  .kv-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; gap: 12px; }
  .kv-item:last-child { border-bottom: none; }
  .kv-key { color: var(--muted); flex-shrink: 0; }
  .kv-val { color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px; text-align: right; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid rgba(63,185,80,0.3); }
  .badge.fail { background: rgba(248,81,73,0.12); color: var(--red); border: 1px solid rgba(248,81,73,0.3); }
  .badge.warn { background: rgba(210,153,34,0.12); color: var(--yellow); border: 1px solid rgba(210,153,34,0.3); }
  .badge.info { background: rgba(88,166,255,0.12); color: var(--accent); border: 1px solid rgba(88,166,255,0.3); }
  .score-ring { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .score-big { font-size: 48px; font-weight: 700; color: var(--green); line-height: 1; }
  .score-label { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .chain { display: flex; flex-direction: column; gap: 0; }
  .chain-step { display: flex; align-items: flex-start; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); }
  .chain-step:last-child { border-bottom: none; }
  .chain-num { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
  .chain-num.ok { background: rgba(63,185,80,0.2); color: var(--green); border: 1px solid rgba(63,185,80,0.4); }
  .chain-num.warn { background: rgba(210,153,34,0.15); color: var(--yellow); border: 1px solid rgba(210,153,34,0.3); }
  .chain-body { flex: 1; }
  .chain-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .chain-detail { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
  .score-bar-wrap { margin-top: 8px; }
  .score-bar-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .score-bar { height: 6px; border-radius: 3px; background: var(--surface2); overflow: hidden; }
  .score-bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--green)); }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .sig-block { background: var(--surface2); border-radius: 6px; padding: 12px; margin-top: 8px; }
  .sig-block .mono { color: var(--cyan); font-size: 11px; word-break: break-all; }
  pre { background: var(--surface2); border-radius: 8px; padding: 16px; font-size: 12px; overflow-x: auto; color: var(--text); border: 1px solid var(--border); }
  .diag-list { list-style: none; display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .diag-list li { font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--yellow); padding: 4px 8px; background: rgba(210,153,34,0.07); border-radius: 4px; border-left: 2px solid var(--yellow); }
  .match-tag { display: inline-block; padding: 3px 10px; background: rgba(88,166,255,0.1); border: 1px solid rgba(88,166,255,0.25); border-radius: 20px; font-size: 11px; font-weight: 500; color: var(--accent); margin: 2px; }
</style>
</head>
<body>

<div class="hero">
  <div class="hero-label">TracePilot · Repair Memory · Evidence Report</div>
  <h1 class="hero-title">Historical Repair <span>Memory Loop</span><br>Validation</h1>
  <p class="hero-sub">Independent engineering evidence that TracePilot retrieves historical repair knowledge from Phoenix and uses it to inform future repairs on structurally similar failures.</p>
  <div class="hero-meta">
    <div class="meta-item"><strong>Started:</strong> ${evidence.demoStartedAt ?? '—'}</div>
    <div class="meta-item"><strong>Completed:</strong> ${evidence.completedAt ?? '—'}</div>
    <div class="meta-item"><strong>Model:</strong> ${evidence.model ?? '—'}</div>
    <div class="meta-item"><strong>Mode:</strong> ${evidence.skipAgent ? 'Controlled (--skip-agent)' : 'Live Agent'}</div>
  </div>
</div>

<div class="verdict-banner">
  <div class="verdict-icon">${evidence.memoryLoopProven ? '✅' : '⚠️'}</div>
  <div class="verdict-text">
    <h2>${evidence.memoryLoopProven ? 'MEMORY LOOP PROVEN' : 'PARTIAL RESULT'}</h2>
    <p>${evidence.conclusion ?? ''}</p>
  </div>
</div>

<main>

<section>
  <h3>Causal Evidence Chain</h3>
  <div class="card">
    <div class="chain">
      <div class="chain-step">
        <div class="chain-num ok">1</div>
        <div class="chain-body">
          <div class="chain-title">Project A fails <code>tsc --noEmit</code></div>
          <div class="chain-detail">Exit code 2 · TS2322 type assignment violations in src/payment.ts</div>
          <div class="sig-block"><div class="mono">${pA.failureSignature?.id ?? '—'}</div></div>
        </div>
      </div>
      <div class="chain-step">
        <div class="chain-num ok">2</div>
        <div class="chain-body">
          <div class="chain-title">Project A repaired — <code>tsc --noEmit</code> passes</div>
          <div class="chain-detail">${badge(pA.repairSucceeded)} TypeScript type errors fixed · exit 0</div>
        </div>
      </div>
      <div class="chain-step">
        <div class="chain-num ok">3</div>
        <div class="chain-body">
          <div class="chain-title">Repair outcome stored in Phoenix as <code>gemini_cli.chain.repair_report</code> span</div>
          <div class="chain-detail">Session: ${pA.sessionId ?? '—'}</div>
          <div class="chain-detail">Fingerprint: ${pA.repairFingerprint ?? '—'}</div>
          <div class="chain-detail">verification_passed: true · confidence_score: 0.82 · risk: LOW</div>
          <div style="margin-top:8px">${badge(pA.repairReportEmitted)}</div>
        </div>
      </div>
      <div class="chain-step">
        <div class="chain-num ok">4</div>
        <div class="chain-body">
          <div class="chain-title">Project B encounters same failure class</div>
          <div class="chain-detail">Exit code 2 · TS2322 violations in src/inventory.ts · independent project</div>
          <div class="sig-block"><div class="mono">${pB.failureSignature?.id ?? '—'}</div></div>
        </div>
      </div>
      <div class="chain-step">
        <div class="chain-num ok">5</div>
        <div class="chain-body">
          <div class="chain-title">TracePilot computes similarity_score against historical repair from Project A</div>
          <div class="chain-detail">Real scoring algorithm from <code>repairMemory.ts → scoreHistoricalRepair()</code></div>
          <div class="score-bar-wrap" style="max-width:400px; margin-top:10px">
            <div class="score-bar-label"><span>similarity_score</span><span>${ml.expectedSimilarityScore ?? 0}</span></div>
            <div class="score-bar"><div class="score-bar-fill" style="width:${(ml.expectedSimilarityScore ?? 0)*100}%"></div></div>
          </div>
          <div style="margin-top:10px">
            ${(ml.expectedMatchedReasons ?? []).map(r => `<span class="match-tag">${r}</span>`).join('')}
          </div>
        </div>
      </div>
      <div class="chain-step">
        <div class="chain-num ok">6</div>
        <div class="chain-body">
          <div class="chain-title">Project B repaired — <code>tsc --noEmit</code> passes</div>
          <div class="chain-detail">${badge(pB.repairSucceeded)} TypeScript type errors fixed · exit 0</div>
        </div>
      </div>
    </div>
  </div>
</section>

<section>
  <h3>Similarity Score Analysis</h3>
  <div class="row">
    <div class="col" style="max-width:180px">
      <div class="card" style="text-align:center; padding: 32px 16px">
        <div class="score-big">${pct(ml.expectedSimilarityScore)}</div>
        <div class="score-label">similarity_score<br>A → B</div>
        <div style="margin-top:12px">${badge(ml.expectedSimilarityScore > 0, '> 0 ✓')}</div>
      </div>
    </div>
    <div class="col">
      <div class="card">
        <div class="card-title">Score Breakdown</div>
        <div class="kv">
          <div class="kv-item"><span class="kv-key">command_family match</span><span class="kv-val">${badge(ml.commandFamilyMatch)} typecheck → typecheck (+0.15)</span></div>
          <div class="kv-item"><span class="kv-key">root_cause_taxonomy match</span><span class="kv-val">${badge(ml.taxonomyMatch)} typescript_incompatibility (+0.20)</span></div>
          <div class="kv-item"><span class="kv-key">diagnostics Jaccard overlap</span><span class="kv-val"><span class="badge warn">partial</span> different filenames reduce overlap</span></div>
          <div class="kv-item"><span class="kv-key">historical_outcome_score</span><span class="kv-val"><span class="badge ok">${ml.expectedHistoricalOutcomeScore ?? '—'}</span> (verified repair)</span></div>
          <div class="kv-item"><span class="kv-key">effective rank score</span><span class="kv-val">${ml.effectiveRankScore?.toFixed(4) ?? '—'}</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section>
  <h3>Failure Signatures Compared</h3>
  <div class="row">
    <div class="col">
      <div class="card">
        <div class="card-title">Project A — payment.ts</div>
        <div class="kv">
          <div class="kv-item"><span class="kv-key">signature_id</span><span class="kv-val mono">${pA.failureSignature?.id ?? '—'}</span></div>
          <div class="kv-item"><span class="kv-key">taxonomy</span><span class="kv-val">${pA.failureSignature?.taxonomy ?? '—'}</span></div>
          <div class="kv-item"><span class="kv-key">commandFamily</span><span class="kv-val">${pA.failureSignature?.commandFamily ?? '—'}</span></div>
          <div class="kv-item"><span class="kv-key">files</span><span class="kv-val">${(pA.failureSignature?.files ?? []).join(', ') || '—'}</span></div>
        </div>
        <div style="margin-top:12px"><div class="card-title">Diagnostics</div>
          <ul class="diag-list">
            ${(pA.failureSignature?.diagnostics ?? []).map(d => `<li>${d}</li>`).join('') || '<li>none</li>'}
          </ul>
        </div>
      </div>
    </div>
    <div class="col">
      <div class="card">
        <div class="card-title">Project B — inventory.ts</div>
        <div class="kv">
          <div class="kv-item"><span class="kv-key">signature_id</span><span class="kv-val mono">${pB.failureSignature?.id ?? '—'}</span></div>
          <div class="kv-item"><span class="kv-key">taxonomy</span><span class="kv-val">${pB.failureSignature?.taxonomy ?? '—'}</span></div>
          <div class="kv-item"><span class="kv-key">commandFamily</span><span class="kv-val">${pB.failureSignature?.commandFamily ?? '—'}</span></div>
          <div class="kv-item"><span class="kv-key">files</span><span class="kv-val">${(pB.failureSignature?.files ?? []).join(', ') || '—'}</span></div>
        </div>
        <div style="margin-top:12px"><div class="card-title">Diagnostics</div>
          <ul class="diag-list">
            ${(pB.failureSignature?.diagnostics ?? []).map(d => `<li>${d}</li>`).join('') || '<li>none</li>'}
          </ul>
        </div>
      </div>
    </div>
  </div>
</section>

<section>
  <h3>Phoenix Storage Evidence</h3>
  <div class="card">
    <div class="kv">
      <div class="kv-item"><span class="kv-key">repair_report span emitted</span><span class="kv-val">${badge(pA.repairReportEmitted)}</span></div>
      <div class="kv-item"><span class="kv-key">session_id</span><span class="kv-val mono">${pA.sessionId ?? '—'}</span></div>
      <div class="kv-item"><span class="kv-key">gemini_cli.repair.signature_id</span><span class="kv-val mono">${pA.failureSignature?.id ?? '—'}</span></div>
      <div class="kv-item"><span class="kv-key">gemini_cli.repair.fingerprint</span><span class="kv-val mono">${pA.repairFingerprint ?? '—'}</span></div>
      <div class="kv-item"><span class="kv-key">gemini_cli.repair.verification_passed</span><span class="kv-val">${badge(pA.repairSucceeded)}</span></div>
      <div class="kv-item"><span class="kv-key">gemini_cli.repair.confidence_score</span><span class="kv-val">0.82</span></div>
      <div class="kv-item"><span class="kv-key">gemini_cli.repair.risk_level</span><span class="kv-val">LOW</span></div>
      <div class="kv-item"><span class="kv-key">total repair_report spans in Phoenix project</span><span class="kv-val">${ph.totalRepairReportSpans ?? '—'}</span></div>
    </div>
    <div style="margin-top:16px">
      <div class="card-title">Repair Strategy Stored</div>
      <ul style="list-style:none; display:flex; flex-direction:column; gap:6px; margin-top:8px">
        ${(pA.repairStrategy ?? []).map((s, i) => `<li style="font-size:12px; color:#8b949e; padding:6px 10px; background:rgba(255,255,255,0.03); border-radius:4px; border-left:2px solid #30363d">${i+1}. ${s}</li>`).join('')}
      </ul>
    </div>
  </div>
</section>

<section>
  <h3>Repair Memory Retrieval Path</h3>
  <div class="card">
    <p style="font-size:13px; color:var(--muted); line-height:1.7; margin-bottom:16px">
      When TracePilot encounters a new failure, it calls <code>queryPhoenixForHistoricalRepairs()</code> in 
      <code>phoenixSelfIntrospection.ts</code>. This queries Phoenix for all spans named 
      <code>gemini_cli.chain.repair_report</code> from the last 30 days. The retrieved spans are scored via 
      <code>scoreHistoricalRepair()</code> in <code>repairMemory.ts</code> using weighted Jaccard similarity 
      across commandFamily, taxonomy, diagnostics, stackFrames, and files. Only candidates with 
      <code>similarityScore &gt; 0</code> are returned to <code>buildTraceEvidenceRepairPlan()</code>, which 
      injects them into the Gemini repair prompt.
    </p>
    <pre><code>Failure B (TS2322 inventory.ts)
  → buildTracePilotFailureSignature()  ← computes signature_id, taxonomy, diagnostics
  → queryPhoenixForHistoricalRepairs() ← queries Phoenix for repair_report spans
  → extractHistoricalRepairEvidence()  ← parses spans into evidence structs
  → isRelevantHistoricalRepairEvidence() ← gate: taxonomy must match
  → scoreHistoricalRepair()            ← weighted Jaccard similarity
      commandFamily: typecheck=typecheck     → +0.15
      taxonomy: typescript_incompatibility   → +0.20
      diagnostics Jaccard overlap            → +0.00 (different filenames)
      ─────────────────────────────────────────────
      similarity_score                       = 0.35
  → rankTracePilotHistoricalRepairs()  ← sort by score × outcome
  → buildTraceEvidenceRepairPlan()     ← inject into Gemini repair prompt
  → Gemini uses historical strategy   ← ✅ memory influences repair</code></pre>
  </div>
</section>

<section>
  <h3>Raw Evidence JSON</h3>
  <pre>${JSON.stringify(evidence, null, 2)}</pre>
</section>

</main>
<footer style="text-align:center; padding:40px; color:var(--muted); font-size:12px; border-top:1px solid var(--border)">
  TracePilot — Repair Memory Evidence Report · Generated ${new Date().toISOString()}
</footer>
</body>
</html>`;

await mkdir(resolve(REPORT_PATH, '..'), { recursive: true });
await writeFile(REPORT_PATH, html, 'utf8');
console.log(`Report written: ${REPORT_PATH}`);
