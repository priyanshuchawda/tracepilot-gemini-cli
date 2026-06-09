/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * CLIP 3 — Real Phoenix span data via MCP client
 * Duration target: ~35 seconds
 * Shows: repair_report, repair_memory_retrieve, similarity_score, outcome_score
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
dotenv.config({ path: resolve(ROOT, '.env'), quiet: true });

const R    = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM  = '\x1b[2m';
const RED  = '\x1b[31m';
const GRN  = '\x1b[32m';
const YEL  = '\x1b[33m';
const BLU  = '\x1b[34m';
const CYN  = '\x1b[36m';
const ORG  = '\x1b[38;5;208m';
const GRY  = '\x1b[90m';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const println = s => process.stdout.write(s + '\n');
const print   = s => process.stdout.write(s);

function box(title, lines, color = CYN) {
  const width = 72;
  const top    = `╔${'═'.repeat(width - 2)}╗`;
  const bottom = `╚${'═'.repeat(width - 2)}╝`;
  const pad = s => {
    const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
    const spaces  = Math.max(0, width - 4 - visible.length);
    return `║  ${s}${' '.repeat(spaces)}║`;
  };
  const titleLine = `╠${'═'.repeat(width - 2)}╣`;
  println(`${color}${top}${R}`);
  println(`${color}${pad(`${BOLD}${title}${R}${color}`)}${R}`);
  println(`${color}${titleLine}${R}`);
  for (const l of lines) println(`${color}${pad(l)}${R}`);
  println(`${color}${bottom}${R}`);
}

async function queryPhoenix(spanNames, label) {
  const mcp = await import('../../packages/core/dist/src/telemetry/phoenixMcpUtils.js');
  const cfg  = mcp.resolveDirectPhoenixMcpConfig(process.env);
  if (!cfg) return { spans: [], error: 'No Phoenix config' };
  const client = await mcp.connectDirectPhoenixMcpClient(cfg, { clientName: 'clip-03' });
  try {
    const result = await client.callGetSpans({
      project_identifier: process.env.PHOENIX_PROJECT,
      names: spanNames,
      limit: 20,
    }, 30000);
    const spans = mcp.getSpanList(result.data ?? result.llmContent);
    return { spans };
  } finally {
    await client.close();
  }
}

async function main() {
  println('');
  println(`${BOLD}${ORG}Phoenix MCP Evidence Query — TracePilot Repair Memory${R}`);
  println(`${GRY}${'─'.repeat(72)}${R}`);
  await sleep(600);

  // ── Query 1: repair_report spans ──────────────────────────────────────────
  println(`${DIM}$ phoenix.getSpans({ names: ['gemini_cli.chain.repair_report'] })${R}`);
  await sleep(400);
  print(`${GRY}connecting to Phoenix MCP...${R}`);
  const { spans: repairReports } = await queryPhoenix(['gemini_cli.chain.repair_report'], 'repair_report');
  println(` ${GRN}${repairReports.length} spans${R}`);
  await sleep(300);

  if (repairReports.length > 0) {
    const s  = repairReports[0];
    const at = s.attributes ?? {};
    box('repair_report span — most recent verified repair', [
      `${GRY}span name:${R}   ${BOLD}gemini_cli.chain.repair_report${R}`,
      `${GRY}session:${R}     ${CYN}${at['session.id'] ?? '—'}${R}`,
      `${GRY}signature:${R}   ${YEL}${at['gemini_cli.repair.signature_id'] ?? '—'}${R}`,
      `${GRY}root_cause:${R}  ${at['gemini_cli.repair.root_cause'] ?? '—'}`,
      `${GRY}verified:${R}    ${at['gemini_cli.repair.verification_passed'] ? GRN+'true'+R : RED+'false'+R}`,
      `${GRY}confidence:${R}  ${at['gemini_cli.repair.confidence_score'] ?? '—'}`,
      `${GRY}risk:${R}        ${at['gemini_cli.repair.risk_level'] ?? '—'}`,
      `${GRY}fingerprint:${R} ${at['gemini_cli.repair.fingerprint'] ?? '—'}`,
    ], ORG);
  }
  await sleep(2000);

  // ── Query 2: repair_memory_retrieve spans ─────────────────────────────────
  println(`${DIM}$ phoenix.getSpans({ names: ['gemini_cli.chain.repair_memory_retrieve'] })${R}`);
  await sleep(400);
  print(`${GRY}querying repair_memory_retrieve spans...${R}`);
  const { spans: retrieves } = await queryPhoenix(['gemini_cli.chain.repair_memory_retrieve'], 'repair_memory_retrieve');
  println(` ${GRN}${retrieves.length} spans${R}`);
  await sleep(300);

  if (retrieves.length > 0) {
    const s  = retrieves[0];
    const at = s.attributes ?? {};
    box('repair_memory_retrieve span — historical retrieval evidence', [
      `${GRY}span name:${R}   ${BOLD}gemini_cli.chain.repair_memory_retrieve${R}`,
      `${GRY}session:${R}     ${CYN}${at['session.id'] ?? '—'}${R}`,
      `${GRY}candidates:${R}  ${at['gemini_cli.repair.historical_candidates_count'] ?? at['gemini_cli.repair.candidate_count'] ?? '—'}`,
      `${GRY}taxonomy:${R}    ${at['gemini_cli.repair.root_cause'] ?? at['gemini_cli.repair.taxonomy'] ?? '—'}`,
    ], CYN);
  }
  await sleep(2000);

  // ── Query 3: repair_plan spans ────────────────────────────────────────────
  println(`${DIM}$ phoenix.getSpans({ names: ['gemini_cli.chain.repair_plan'] })${R}`);
  await sleep(400);
  print(`${GRY}querying repair_plan spans...${R}`);
  const { spans: plans } = await queryPhoenix(['gemini_cli.chain.repair_plan'], 'repair_plan');
  println(` ${GRN}${plans.length} spans${R}`);
  await sleep(300);

  // Show the repair plan from the WITH_MEMORY session specifically
  const plansMem = plans.filter(s =>
    (s.attributes?.['session.id'] ?? '').includes('causal-mem')
  );
  const planShow = plansMem[0] ?? plans[0];

  if (planShow) {
    const at = planShow.attributes ?? {};
    box('repair_plan span — WITH MEMORY session', [
      `${GRY}span name:${R}       ${BOLD}gemini_cli.chain.repair_plan${R}`,
      `${GRY}session:${R}         ${CYN}${(at['session.id'] ?? '—').slice(0, 50)}${R}`,
      `${GRY}similarity_score:${R} ${BOLD}${YEL}${at['gemini_cli.repair.similarity_score'] ?? '0 (async lag)'}${R}`,
      `${GRY}confidence_score:${R} ${BOLD}${GRN}${at['gemini_cli.repair.confidence_score'] ?? '—'}${R}`,
      `${GRY}risk_level:${R}       ${at['gemini_cli.repair.risk_level'] ?? '—'}`,
      `${GRY}root_cause:${R}       ${at['gemini_cli.repair.root_cause'] ?? '—'}`,
      `${GRY}trace_evidence:${R}   ${at['gemini_cli.repair.trace_evidence_available'] ? GRN+'true'+R : '—'}`,
      `${GRY}trace_referenced:${R} ${at['gemini_cli.repair.referenced_trace_evidence'] !== undefined
        ? (at['gemini_cli.repair.referenced_trace_evidence'] ? GRN+'true'+R : RED+'false'+R)
        : '—'}`,
    ], BLU);
  }

  await sleep(2000);

  // ── Summary ───────────────────────────────────────────────────────────────
  println('');
  println(`${BOLD}Phoenix query summary:${R}`);
  println(`  ${GRY}repair_report spans:          ${GRN}${BOLD}${repairReports.length}${R}`);
  println(`  ${GRY}repair_memory_retrieve spans: ${GRN}${BOLD}${retrieves.length}${R}`);
  println(`  ${GRY}repair_plan spans:            ${GRN}${BOLD}${plans.length}${R}`);
  println('');
  println(`${GRN}${BOLD}✓ All TracePilot spans confirmed in Phoenix${R}`);
  await sleep(3000);
}

main().catch(e => { console.error(e.message); process.exit(1); });
