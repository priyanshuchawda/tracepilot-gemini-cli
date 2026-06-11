/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TracePilot Causal Differential Experiment
 *
 * Runs Project B twice under identical conditions:
 *   Run 1: TracePilot WITH repair memory (historical repairs present in Phoenix project)
 *   Run 2: TracePilot WITHOUT repair memory (same API key, isolated project — zero history)
 *
 * Captures: repair_plan spans, actual file diffs, agent output
 * Outputs:  causal-differential-evidence.json + diff report
 *
 * Usage: node scripts/run-causal-differential.mjs
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(ROOT, '.env'), quiet: true });

const DEMO_DIR = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo');
const PROJECT_B_SRC = resolve(DEMO_DIR, 'project-b');
const EVIDENCE_DIR = resolve(DEMO_DIR, 'evidence');
const CLI_PATH = resolve(ROOT, 'packages/cli/dist/index.js');
const MODEL = 'gemini-3.1-flash-lite-preview';

// ── helpers ──────────────────────────────────────────────────────────────────

const log = msg => process.stderr.write(`\n${msg}\n`);
const logStep = (n, t, msg) => process.stderr.write(`\n[${n}/${t}] ${msg}\n`);
const logOk = msg => process.stderr.write(`  ✅ ${msg}\n`);
const logFail = msg => process.stderr.write(`  ❌ ${msg}\n`);
const logInfo = msg => process.stderr.write(`  ℹ️  ${msg}\n`);

function findTsc(dir) {
  const win = resolve(dir, 'node_modules/.bin/tsc.cmd');
  if (process.platform === 'win32' && existsSync(win)) return { cmd: win, args: [] };
  return { cmd: 'npx', args: ['tsc'] };
}

async function runProcess(cmd, args, cwd, env = {}, timeoutMs = 300_000) {
  return new Promise(res => {
    const isCmd = cmd.endsWith('.cmd') || cmd.endsWith('.bat');
    const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: isCmd, windowsHide: true });
    const chunks = [];
    proc.stdout?.on('data', d => chunks.push(d));
    proc.stderr?.on('data', d => chunks.push(d));
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.on('close', code => { clearTimeout(timer); res({ exitCode: code ?? 1, output: Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8') }); });
    proc.on('error', e => { clearTimeout(timer); res({ exitCode: 1, output: e.message }); });
  });
}

async function queryPhoenixSession(sessionId) {
  const mcp = await import('../packages/core/dist/src/telemetry/phoenixMcpUtils.js');
  const cfg = mcp.resolveDirectPhoenixMcpConfig(process.env);
  if (!cfg) return { spans: [], available: false };
  const client = await mcp.connectDirectPhoenixMcpClient(cfg, { clientName: 'causal-diff' });
  try {
    const result = await client.callGetSpans({ project_identifier: process.env.PHOENIX_PROJECT, limit: 200 }, 30000);
    const all = mcp.getSpanList(result.data ?? result.llmContent);
    return { spans: all.filter(s => s.attributes?.['session.id'] === sessionId), available: true };
  } finally { await client.close(); }
}

async function queryPhoenixSessionInProject(sessionId, projectName) {
  const mcp = await import('../packages/core/dist/src/telemetry/phoenixMcpUtils.js');
  const cfg = mcp.resolveDirectPhoenixMcpConfig(process.env);
  if (!cfg) return { spans: [], available: false };
  const client = await mcp.connectDirectPhoenixMcpClient(cfg, { clientName: 'causal-diff-isolated' });
  try {
    const result = await client.callGetSpans({ project_identifier: projectName, limit: 200 }, 30000);
    const all = mcp.getSpanList(result.data ?? result.llmContent);
    return { spans: all.filter(s => s.attributes?.['session.id'] === sessionId), available: true };
  } finally { await client.close(); }
}


// ── Run TracePilot agent with captured output ─────────────────────────────────

async function runAgentCapture(projectDir, sessionId, label, envOverrides = {}) {
  logInfo(`Starting agent [${label}] (session: ${sessionId})`);
  const prompt = [
    'You are repairing a TypeScript project that has type errors.',
    'First run: npx tsc --noEmit to see all errors.',
    'Fix all TypeScript type errors in src/inventory.ts.',
    'After fixing, run npx tsc --noEmit again and confirm exit 0.',
    'Do NOT delete files.',
  ].join(' ');

  const result = await runProcess(
    process.execPath,
    [CLI_PATH, '--prompt', prompt, '--session-id', sessionId,
     '--approval-mode=yolo', '--sandbox=false', '--skip-trust',
     '--model', MODEL, '--output-format', 'stream-json'],
    projectDir,
    {
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
      GEMINI_CLI_NO_RELAUNCH: 'true',
      ...envOverrides,
    },
    8 * 60 * 1000,
  );
  logInfo(`Agent [${label}] finished (exit ${result.exitCode})`);
  return result;
}

// ── Restore project B to broken state ─────────────────────────────────────────

const BROKEN_SOURCE = `// Project B: Inventory management service
// BUG: Same failure class as Project A — TS2322 strict null check violations

interface Product {
  id: number;
  title?: string;
  price: number;
}

function getProductTitle(product: Product): string | undefined {
  return product.title;
}

function generateInvoice(productId: number): string {
  const product: Product = { id: productId, price: 29.99 };
  // BUG: getProductTitle returns string | undefined but productTitle expects string
  const productTitle: string = getProductTitle(product);
  return \`Invoice for product: \${productTitle} (ID: \${productId})\`;
}

function calculateDiscount(price: number, percent: number): string {
  // BUG: toFixed returns string but discountedPrice expects number
  const discountedPrice: number = (price * (1 - percent / 100)).toFixed(2);
  return \`Discounted price: \${discountedPrice}\`;
}

export { generateInvoice, calculateDiscount };
`;

async function restoreProjectB() {
  await writeFile(resolve(PROJECT_B_SRC, 'src/inventory.ts'), BROKEN_SOURCE, 'utf8');
  logInfo('Project B restored to broken state');
}

async function captureRepairedSource() {
  const path = resolve(PROJECT_B_SRC, 'src/inventory.ts');
  if (existsSync(path)) return await readFile(path, 'utf8');
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });

  log('═══════════════════════════════════════════════════════════════');
  log('  TracePilot Causal Differential Experiment');
  log('  Question: Does repair memory CHANGE the repair strategy?');
  log('═══════════════════════════════════════════════════════════════');

  const evidence = {
    experimentStartedAt: new Date().toISOString(),
    model: MODEL,
    question: 'Does repair memory materially change repair planning vs cold-start?',
    withMemory: {},
    withoutMemory: {},
    differential: {},
  };

  // ── RUN 1: WITH MEMORY ────────────────────────────────────────────────────
  logStep(1, 6, 'RUN 1: WITH MEMORY — TracePilot with Phoenix retrieval active');

  await restoreProjectB();
  const sessionMem = `tracepilot-causal-mem-${Date.now()}`;
  evidence.withMemory.sessionId = sessionMem;

  const agentMemResult = await runAgentCapture(PROJECT_B_SRC, sessionMem, 'WITH_MEMORY', {
    // Full Phoenix env — repair memory retrieval active
    PHOENIX_API_KEY: process.env.PHOENIX_API_KEY,
    PHOENIX_BASE_URL: process.env.PHOENIX_BASE_URL,
    PHOENIX_COLLECTOR_ENDPOINT: process.env.PHOENIX_COLLECTOR_ENDPOINT,
    PHOENIX_PROJECT: process.env.PHOENIX_PROJECT,
  });

  evidence.withMemory.agentExitCode = agentMemResult.exitCode;
  evidence.withMemory.agentOutput = agentMemResult.output.slice(-3000); // last 3k chars

  const tscB = findTsc(PROJECT_B_SRC);
  const verifyMem = await runProcess(tscB.cmd, [...tscB.args, '--noEmit'], PROJECT_B_SRC);
  evidence.withMemory.tscPassed = verifyMem.exitCode === 0;
  evidence.withMemory.repairedSource = await captureRepairedSource();

  if (verifyMem.exitCode === 0) logOk('Run 1 (WITH MEMORY): tsc passes'); else logFail('Run 1 (WITH MEMORY): tsc still fails');

  // Wait for Phoenix to index Run 1 spans
  logStep(2, 6, 'Waiting 20s for Run 1 Phoenix spans to index...');
  await new Promise(r => setTimeout(r, 20000));

  const phoenixMem = await queryPhoenixSession(sessionMem);
  const planSpanMem = phoenixMem.spans.find(s => s.name === 'gemini_cli.chain.repair_plan');
  const retrieveSpanMem = phoenixMem.spans.find(s => s.name === 'gemini_cli.chain.repair_memory_retrieve');
  evidence.withMemory.phoenixSpans = {
    total: phoenixMem.spans.length,
    spanNames: [...new Set(phoenixMem.spans.map(s => s.name))].sort(),
    repairPlan: planSpanMem ? {
      similarity_score: planSpanMem.attributes?.['gemini_cli.repair.similarity_score'],
      confidence_score: planSpanMem.attributes?.['gemini_cli.repair.confidence_score'],
      risk_level: planSpanMem.attributes?.['gemini_cli.repair.risk_level'],
      root_cause: planSpanMem.attributes?.['gemini_cli.repair.root_cause'],
      signature_id: planSpanMem.attributes?.['gemini_cli.repair.signature_id'],
      strategy: planSpanMem.attributes?.['gemini_cli.repair.strategy'],
      regression_confidence: planSpanMem.attributes?.['gemini_cli.repair.regression_confidence'],
      trace_evidence_available: planSpanMem.attributes?.['gemini_cli.repair.trace_evidence_available'],
      referenced_trace_evidence: planSpanMem.attributes?.['gemini_cli.repair.referenced_trace_evidence'],
      phoenix_trace_ids: planSpanMem.attributes?.['gemini_cli.repair.phoenix_trace_ids_consulted'],
    } : null,
    repairMemoryRetrieve: retrieveSpanMem ? {
      name: retrieveSpanMem.name,
      attributes: retrieveSpanMem.attributes,
    } : null,
  };

  logInfo(`Run 1 spans: ${phoenixMem.spans.length}`);
  logInfo(`repair_plan similarity_score: ${evidence.withMemory.phoenixSpans.repairPlan?.similarity_score ?? 'N/A'}`);
  logInfo(`repair_plan confidence_score: ${evidence.withMemory.phoenixSpans.repairPlan?.confidence_score ?? 'N/A'}`);
  logInfo(`repair_plan risk_level: ${evidence.withMemory.phoenixSpans.repairPlan?.risk_level ?? 'N/A'}`);
  logInfo(`repair_memory_retrieve present: ${!!retrieveSpanMem}`);

  // ── RUN 2: WITHOUT MEMORY ─────────────────────────────────────────────────
  // Key insight: Do NOT blank the API key — that suppresses ALL telemetry and
  // prevents us from capturing the repair_plan span for comparison.
  // Instead, use an isolated Phoenix project name with zero historical repairs.
  // TracePilot will find no matching history → cold start → repair_plan spans
  // still emit to Phoenix and can be queried for the differential.
  logStep(3, 6, 'RUN 2: WITHOUT MEMORY — isolated Phoenix project (zero history, telemetry active)');

  await restoreProjectB();
  const sessionNoMem = `tracepilot-causal-nomem-${Date.now()}`;
  const isolatedProject = `tracepilot-causal-nomem-isolated-${Date.now()}`;
  evidence.withoutMemory.sessionId = sessionNoMem;
  evidence.withoutMemory.isolatedProject = isolatedProject;

  const agentNoMemResult = await runAgentCapture(PROJECT_B_SRC, sessionNoMem, 'NO_MEMORY', {
    // Keep API key valid so repair_plan spans ARE emitted to Phoenix.
    // Use an isolated project with zero history → historical retrieval returns empty.
    PHOENIX_API_KEY: process.env.PHOENIX_API_KEY,
    PHOENIX_BASE_URL: process.env.PHOENIX_BASE_URL,
    PHOENIX_COLLECTOR_ENDPOINT: process.env.PHOENIX_COLLECTOR_ENDPOINT,
    PHOENIX_PROJECT: isolatedProject,   // ← fresh project, no repair history
  });

  evidence.withoutMemory.agentExitCode = agentNoMemResult.exitCode;
  evidence.withoutMemory.agentOutput = agentNoMemResult.output.slice(-3000);

  const verifyNoMem = await runProcess(tscB.cmd, [...tscB.args, '--noEmit'], PROJECT_B_SRC);
  evidence.withoutMemory.tscPassed = verifyNoMem.exitCode === 0;
  evidence.withoutMemory.repairedSource = await captureRepairedSource();

  if (verifyNoMem.exitCode === 0) logOk('Run 2 (NO MEMORY): tsc passes'); else logFail('Run 2 (NO MEMORY): tsc still fails');

  // Wait for Phoenix to index Run 2 spans
  logStep(4, 6, 'Waiting 20s for Run 2 Phoenix spans to index...');
  await new Promise(r => setTimeout(r, 20000));

  // Query Run 2 spans from the isolated project
  const phoenixNoMem = await queryPhoenixSessionInProject(sessionNoMem, isolatedProject);
  const planSpanNoMem = phoenixNoMem.spans.find(s => s.name === 'gemini_cli.chain.repair_plan');
  const retrieveSpanNoMem = phoenixNoMem.spans.find(s => s.name === 'gemini_cli.chain.repair_memory_retrieve');

  evidence.withoutMemory.phoenixSpans = {
    total: phoenixNoMem.spans.length,
    spanNames: [...new Set(phoenixNoMem.spans.map(s => s.name))].sort(),
    repairPlan: planSpanNoMem ? {
      similarity_score: planSpanNoMem.attributes?.['gemini_cli.repair.similarity_score'],
      confidence_score: planSpanNoMem.attributes?.['gemini_cli.repair.confidence_score'],
      risk_level: planSpanNoMem.attributes?.['gemini_cli.repair.risk_level'],
      root_cause: planSpanNoMem.attributes?.['gemini_cli.repair.root_cause'],
      signature_id: planSpanNoMem.attributes?.['gemini_cli.repair.signature_id'],
      strategy: planSpanNoMem.attributes?.['gemini_cli.repair.strategy'],
      regression_confidence: planSpanNoMem.attributes?.['gemini_cli.repair.regression_confidence'],
      trace_evidence_available: planSpanNoMem.attributes?.['gemini_cli.repair.trace_evidence_available'],
      referenced_trace_evidence: planSpanNoMem.attributes?.['gemini_cli.repair.referenced_trace_evidence'],
    } : null,
    repairMemoryRetrieve: retrieveSpanNoMem ? { name: retrieveSpanNoMem.name } : null,
  };

  logInfo(`Run 2 spans: ${phoenixNoMem.spans.length}`);
  logInfo(`repair_plan similarity_score: ${evidence.withoutMemory.phoenixSpans.repairPlan?.similarity_score ?? 'N/A'}`);
  logInfo(`repair_plan confidence_score: ${evidence.withoutMemory.phoenixSpans.repairPlan?.confidence_score ?? 'N/A'}`);
  logInfo(`repair_plan risk_level: ${evidence.withoutMemory.phoenixSpans.repairPlan?.risk_level ?? 'N/A'}`);

  // ── STEP 5: Compute differential ─────────────────────────────────────────
  logStep(5, 6, 'Computing causal differential');

  const planMem = evidence.withMemory.phoenixSpans.repairPlan ?? {};
  const planNoMem = evidence.withoutMemory.phoenixSpans.repairPlan ?? {};

  const confMem = planMem.confidence_score ?? null;
  const confNoMem = planNoMem.confidence_score ?? null;
  const riskMem = planMem.risk_level ?? null;
  const riskNoMem = planNoMem.risk_level ?? null;
  const simMem = planMem.similarity_score ?? null;
  const simNoMem = planNoMem.similarity_score ?? null;
  const traceRefMem = planMem.referenced_trace_evidence ?? null;
  const traceRefNoMem = planNoMem.referenced_trace_evidence ?? null;

  const confDelta = confMem !== null && confNoMem !== null ? (confMem - confNoMem) : null;

  // Source diff analysis
  const srcMem = evidence.withMemory.repairedSource ?? '';
  const srcNoMem = evidence.withoutMemory.repairedSource ?? '';

  // Extract the key fix patterns from each repaired source
  const fixPatternMem = extractFixPatterns(srcMem);
  const fixPatternNoMem = extractFixPatterns(srcNoMem);

  evidence.differential = {
    memory_retrieved: !!evidence.withMemory.phoenixSpans.repairMemoryRetrieve,
    similarity_score_with_memory: simMem,
    similarity_score_without_memory: simNoMem,
    confidence_with_memory: confMem,
    confidence_without_memory: confNoMem,
    confidence_delta: confDelta,
    confidence_changed: confDelta !== null && Math.abs(confDelta) > 0.01,
    risk_with_memory: riskMem,
    risk_without_memory: riskNoMem,
    risk_changed: riskMem !== riskNoMem,
    trace_referenced_with_memory: traceRefMem,
    trace_referenced_without_memory: traceRefNoMem,
    trace_reference_changed: traceRefMem !== traceRefNoMem,
    fix_patterns_with_memory: fixPatternMem,
    fix_patterns_without_memory: fixPatternNoMem,
    source_identical: srcMem.trim() === srcNoMem.trim(),
    source_uses_same_patterns: fixPatternMem.sort().join(',') === fixPatternNoMem.sort().join(','),
    strategy_with_memory: parseStrategy(planMem.strategy),
    strategy_without_memory: parseStrategy(planNoMem.strategy),
    causal_influence_verdict: null,
    causal_influence_explanation: null,
  };

  // Determine verdict
  const memVsNoMem = [];

  if (evidence.differential.confidence_changed) {
    memVsNoMem.push(`confidence: ${(confMem*100).toFixed(0)}% vs ${(confNoMem*100).toFixed(0)}% (Δ=${confDelta >= 0 ? '+' : ''}${(confDelta*100).toFixed(1)}%)`);
  }
  if (evidence.differential.risk_changed) {
    memVsNoMem.push(`risk: ${riskMem} vs ${riskNoMem}`);
  }
  if (evidence.differential.trace_reference_changed) {
    memVsNoMem.push(`trace_referenced: ${traceRefMem} vs ${traceRefNoMem}`);
  }
  if (!evidence.differential.source_uses_same_patterns) {
    memVsNoMem.push(`fix patterns differ: [${fixPatternMem.join(', ')}] vs [${fixPatternNoMem.join(', ')}]`);
  }

  if (memVsNoMem.length > 0) {
    evidence.differential.causal_influence_verdict = 'CAUSAL_INFLUENCE_DETECTED';
    evidence.differential.causal_influence_explanation = `Memory changed: ${memVsNoMem.join('; ')}`;
  } else if (evidence.differential.memory_retrieved) {
    evidence.differential.causal_influence_verdict = 'MEMORY_RETRIEVED_NO_PLAN_DELTA';
    evidence.differential.causal_influence_explanation = 'Memory was retrieved (similarity_score>0 expected) but repair plan attributes are identical. The LLM applied the same fix either way — which is expected for deterministic TypeScript errors with limited fix strategies.';
  } else {
    evidence.differential.causal_influence_verdict = 'COLD_START_BOTH';
    evidence.differential.causal_influence_explanation = 'Neither run had historical repair context available. This is a control case.';
  }

  log('\n  ── Differential Summary ──────────────────────────────────');
  logInfo(`similarity_score: WITH=${simMem}  WITHOUT=${simNoMem}`);
  logInfo(`confidence: WITH=${confMem}  WITHOUT=${confNoMem}  Δ=${confDelta?.toFixed(4) ?? 'N/A'}`);
  logInfo(`risk: WITH=${riskMem}  WITHOUT=${riskNoMem}  changed=${evidence.differential.risk_changed}`);
  logInfo(`trace_referenced: WITH=${traceRefMem}  WITHOUT=${traceRefNoMem}`);
  logInfo(`source_identical: ${evidence.differential.source_identical}`);
  logInfo(`fix_patterns_match: ${evidence.differential.source_uses_same_patterns}`);
  log(`\n  VERDICT: ${evidence.differential.causal_influence_verdict}`);
  log(`  ${evidence.differential.causal_influence_explanation}`);

  // ── STEP 6: Write evidence ────────────────────────────────────────────────
  logStep(6, 6, 'Writing evidence files');
  evidence.completedAt = new Date().toISOString();

  const evidencePath = resolve(EVIDENCE_DIR, 'causal-differential-evidence.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  logOk(`Evidence: ${evidencePath}`);

  return evidence;
}

function extractFixPatterns(src) {
  const patterns = [];
  if (src.includes('?? ') || src.includes('??\n')) patterns.push('nullish-coalescing');
  if (src.includes('parseFloat(')) patterns.push('parseFloat');
  if (src.includes(' as string')) patterns.push('type-cast-string');
  if (src.includes(' as number')) patterns.push('type-cast-number');
  if (src.includes('String(')) patterns.push('String-constructor');
  if (src.includes('Number(')) patterns.push('Number-constructor');
  if (src.includes('?.')) patterns.push('optional-chaining');
  if (src.includes('|| \'') || src.includes("|| \"")) patterns.push('or-fallback-string');
  return patterns;
}

function parseStrategy(rawStrategy) {
  if (!rawStrategy) return [];
  try { return JSON.parse(rawStrategy); } catch { return [rawStrategy]; }
}

main()
  .then(ev => {
    process.stdout.write(JSON.stringify({ verdict: ev.differential.causal_influence_verdict, explanation: ev.differential.causal_influence_explanation }, null, 2));
    process.exit(0);
  })
  .catch(err => {
    process.stderr.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
