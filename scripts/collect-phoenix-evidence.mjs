#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phoenix Evidence Collection Script
 * Queries Phoenix MCP for spans created during the benchmark run,
 * then generates a structured evidence report showing the evidence chain:
 *   Failure → Phoenix MCP query → Evidence retrieved → Repair plan changed → Verification result
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });

const phaseRoot = '.ai-logs/tracepilot-independent-eval/phase3-nextjs-five';
const outputDir = '.ai-logs/tracepilot-independent-eval/phase4-phoenix-evidence';
await mkdir(outputDir, { recursive: true });

// Load comparison report
const reportPath = (await readFile(path.join(phaseRoot, 'latest-agent-comparison.txt'), 'utf8')).trim();
const report = JSON.parse(await readFile(reportPath, 'utf8'));

// Load Phoenix MCP utils
const mcp = await import('../packages/core/dist/src/telemetry/phoenixMcpUtils.js');
const cfg = mcp.resolveDirectPhoenixMcpConfig(process.env);
if (!cfg) {
  console.error('Phoenix MCP config not resolved. Check PHOENIX_API_KEY, PHOENIX_PROJECT, PHOENIX_BASE_URL.');
  process.exit(1);
}

console.log(`Connecting to Phoenix MCP at ${cfg.host}...`);
const client = await mcp.connectDirectPhoenixMcpClient(cfg, { clientName: 'tracepilot-evidence-collector' });

// Time range: 30 minutes before earliest benchmark result to now
const runStart = report.results.reduce((min, r) => r.timeline.startedAt < min ? r.timeline.startedAt : min, new Date().toISOString());
const startTime = new Date(new Date(runStart).getTime() - 30 * 60 * 1000).toISOString();

console.log(`Querying spans from ${startTime} to now...`);

const allSpansResult = await client.callGetSpans({
  project_identifier: process.env.PHOENIX_PROJECT,
  start_time: startTime,
  limit: 500,
}, 60000);

if (allSpansResult.error) {
  console.error('Error querying spans:', allSpansResult.error.message);
  await client.close();
  process.exit(1);
}

const allSpans = mcp.getSpanList(allSpansResult.data ?? allSpansResult.llmContent);
console.log(`Total spans retrieved: ${allSpans.length}`);

// Group spans by session ID
const bySession = {};
for (const span of allSpans) {
  const session = span.attributes?.['session.id'] ?? 'unknown';
  if (!bySession[session]) bySession[session] = [];
  bySession[session].push(span);
}

// Build evidence chains per TracePilot benchmark run
const evidenceChains = [];
for (const result of report.results) {
  if (result.arm !== 'tracepilot') continue;
  
  const sessionSpans = bySession[result.sessionId] ?? [];
  const spansByName = {};
  for (const span of sessionSpans) {
    if (!spansByName[span.name]) spansByName[span.name] = [];
    spansByName[span.name].push(span);
  }
  
  // Find the self-introspection span (Phoenix MCP query)
  const introspectionSpans = spansByName['gemini_cli.chain.self_introspection'] ?? [];
  const repairPlanSpans = spansByName['gemini_cli.chain.repair_plan'] ?? [];
  const repairMemorySpans = spansByName['gemini_cli.chain.repair_memory_retrieve'] ?? [];
  const phoenixMcpSpans = spansByName['gemini_cli.tool.phoenix_mcp'] ?? [];
  const shellSpans = spansByName['gemini_cli.tool.shell'] ?? [];
  const failedShells = shellSpans.filter(s => 
    s.attributes?.['tracepilot.failure_signature'] || 
    s.attributes?.['error'] === 'true' ||
    (s.status && s.status !== 'OK')
  );
  
  // Extract repair plan details
  const repairPlan = repairPlanSpans[0];
  const introspection = introspectionSpans[0];
  
  const chain = {
    benchmarkId: result.benchmarkId,
    sessionId: result.sessionId,
    arm: result.arm,
    fixed: result.fixed,
    repairTimeMs: result.metrics.repairTimeMs,
    verificationResult: result.after.exitCode === 0 ? 'PASSED' : 'FAILED',
    spansSummary: {
      total: sessionSpans.length,
      byType: Object.fromEntries(Object.entries(spansByName).map(([k, v]) => [k, v.length])),
    },
    evidenceChain: {
      step1_failure: {
        found: failedShells.length > 0 || sessionSpans.length > 0,
        failedToolCalls: failedShells.length,
        verifierBeforeResult: result.before.exitCode,
        verifierBeforePreview: result.before.outputPreview?.slice(0, 500) ?? 'not captured',
      },
      step2_phoenixQuery: {
        found: introspectionSpans.length > 0 || phoenixMcpSpans.length > 0,
        introspectionSpanCount: introspectionSpans.length,
        phoenixMcpCallCount: phoenixMcpSpans.length,
        evidenceAvailable: introspection?.attributes?.['tracepilot.phoenix_evidence_available'] ?? null,
        sessionId: introspection?.attributes?.['session.id'] ?? null,
      },
      step3_repairPlan: {
        found: repairPlanSpans.length > 0,
        repairPlanCount: repairPlanSpans.length,
        source: repairPlan?.attributes?.['tracepilot.repair_source'] ?? null,
        confidenceScore: repairPlan?.attributes?.['tracepilot.confidence_score'] ?? null,
        riskLevel: repairPlan?.attributes?.['tracepilot.risk_level'] ?? null,
        failureSignature: repairPlan?.attributes?.['tracepilot.failure_signature'] ?? null,
        historicalCandidates: repairPlan?.attributes?.['tracepilot.historical_candidates'] ?? null,
        strategyDifferentFromBlind: repairPlan?.attributes?.['tracepilot.repair_source'] === 'phoenix_trace',
      },
      step4_historyRetrieve: {
        found: repairMemorySpans.length > 0,
        repairMemorySpanCount: repairMemorySpans.length,
        matchedHistoricalRepairs: repairMemorySpans[0]?.attributes?.['tracepilot.matched_repairs'] ?? 0,
      },
      step5_verificationResult: {
        verifierAfterExitCode: result.after.exitCode,
        passed: result.fixed,
        changedFiles: result.changedFiles,
      },
    },
    rawSpans: {
      repairPlan: repairPlan ?? null,
      introspection: introspection ?? null,
      repairMemory: repairMemorySpans[0] ?? null,
    },
  };
  evidenceChains.push(chain);
}

// Also check prior sessions for historical comparison
const priorSessionIds = [
  'tracepilot-nextjs-next-70213-tracepilot-1780984018514',
  'tracepilot-nextjs-next-59950-tracepilot-1780983484239',
  'tracepilot-nextjs-next-73796-tracepilot-1780982922745',
];

const historicalEvidence = {};
for (const sessionId of priorSessionIds) {
  const spans = bySession[sessionId] ?? [];
  const repairPlans = spans.filter(s => s.name === 'gemini_cli.chain.repair_plan');
  historicalEvidence[sessionId] = {
    totalSpans: spans.length,
    repairPlanSpans: repairPlans.length,
    repairPlanSources: repairPlans.map(s => s.attributes?.['tracepilot.repair_source'] ?? 'unknown'),
  };
}

const evidenceReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmarkRunId: path.basename(report.runRoot),
  phoenixProject: process.env.PHOENIX_PROJECT,
  totalSpansRetrieved: allSpans.length,
  uniqueSessions: Object.keys(bySession).length,
  benchmarkSessionIds: report.results.filter(r => r.arm === 'tracepilot').map(r => r.sessionId),
  evidenceChains,
  historicalEvidence,
  summary: {
    totalTracepilotArms: evidenceChains.length,
    armsWithPhoenixQuery: evidenceChains.filter(c => c.evidenceChain.step2_phoenixQuery.found).length,
    armsWithRepairPlan: evidenceChains.filter(c => c.evidenceChain.step3_repairPlan.found).length,
    armsWithHistoryRetrieval: evidenceChains.filter(c => c.evidenceChain.step4_historyRetrieve.found).length,
    armsFixed: evidenceChains.filter(c => c.fixed).length,
    armsWithPhoenixTraceSource: evidenceChains.filter(c => c.evidenceChain.step3_repairPlan.strategyDifferentFromBlind).length,
  },
};

const outputPath = path.join(outputDir, 'phoenix-evidence-report.json');
await writeFile(outputPath, `${JSON.stringify(evidenceReport, null, 2)}\n`, 'utf8');
console.log(`Phoenix evidence report: ${outputPath}`);
console.log('\n=== EVIDENCE CHAIN SUMMARY ===');
for (const chain of evidenceChains) {
  const c = chain.evidenceChain;
  console.log(`\n[${chain.benchmarkId}] session=${chain.sessionId}`);
  console.log(`  Step 1 - Failure: verifier exit ${c.step1_failure.verifierBeforeResult} (${c.step1_failure.failedToolCalls} failed shell calls)`);
  console.log(`  Step 2 - Phoenix Query: ${c.step2_phoenixQuery.found ? '✅ found' : '❌ not found'} (${c.step2_phoenixQuery.introspectionSpanCount} introspection, ${c.step2_phoenixQuery.phoenixMcpCallCount} MCP calls)`);
  console.log(`  Step 3 - Repair Plan: ${c.step3_repairPlan.found ? '✅ found' : '❌ not found'} source=${c.step3_repairPlan.source ?? 'unknown'} confidence=${c.step3_repairPlan.confidenceScore ?? '?'}`);
  console.log(`  Step 4 - History: ${c.step4_historyRetrieve.found ? '✅ retrieved' : '❌ not found'} (${c.step4_historyRetrieve.repairMemorySpanCount} spans)`);
  console.log(`  Step 5 - Verification: ${c.verificationResult} (fixed=${chain.fixed})`);
}

await client.close();
console.log('\nEvidence collection complete.');
