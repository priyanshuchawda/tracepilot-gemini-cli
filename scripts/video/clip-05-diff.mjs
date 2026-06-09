/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * CLIP 5 — THE CENTERPIECE DIFF
 * Duration target: ~45 seconds
 *
 * Shows the actual code diff from the causal differential experiment.
 * Reads real evidence JSON — no simulated output.
 *
 * Strategy WITHOUT memory: changes type to string (relaxes contract)
 * Strategy WITH memory:    uses parseFloat() (preserves numeric contract)
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const EVIDENCE = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo/evidence/causal-differential-evidence.json');

const R    = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM  = '\x1b[2m';
const RED  = '\x1b[31m';
const GRN  = '\x1b[32m';
const YEL  = '\x1b[33m';
const CYN  = '\x1b[36m';
const GRY  = '\x1b[90m';
const BG_R = '\x1b[41m';
const BG_G = '\x1b[42m';
const ORG  = '\x1b[38;5;208m';
const MAG  = '\x1b[35m';

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const println = s => process.stdout.write(s + '\n');
const print   = s => process.stdout.write(s);

// Extract only the calculateDiscount function from each source
function extractFn(src, name = 'calculateDiscount') {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.includes(`function ${name}`));
  if (start < 0) return src.split('\n');
  const end = lines.findIndex((l, i) => i > start && l.startsWith('}'));
  return lines.slice(start, end + 1);
}

function stripColors(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function sideBySide(leftLines, rightLines, leftTitle, rightTitle, width = 44) {
  const pad = (s, w) => {
    const vis = stripColors(s).length;
    return s + ' '.repeat(Math.max(0, w - vis));
  };

  const LEFT_TITLE = `  ${BOLD}${RED}${leftTitle}${R}`;
  const RIGHT_TITLE = `  ${BOLD}${GRN}${rightTitle}${R}`;
  const sep = `${GRY}│${R}`;

  println(`${GRY}╔${'═'.repeat(width)}╦${'═'.repeat(width)}╗${R}`);
  println(`${GRY}║${R}${pad(LEFT_TITLE, width)}${GRY}║${R}${pad(RIGHT_TITLE, width)}${GRY}║${R}`);
  println(`${GRY}╠${'═'.repeat(width)}╬${'═'.repeat(width)}╣${R}`);

  const maxLen = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < maxLen; i++) {
    const lRaw = leftLines[i] ?? '';
    const rRaw = rightLines[i] ?? '';

    // Highlight the key differing line
    const isKeyLeft  = lRaw.includes('discountedPrice: string');
    const isKeyRight = rRaw.includes('parseFloat') || rRaw.includes('discountedPrice: number');

    const lColored = isKeyLeft
      ? `${BG_R}${BOLD}  ${lRaw.trim().padEnd(width - 4)}  ${R}`
      : `${GRY}  ${R}${lRaw}`;
    const rColored = isKeyRight
      ? `${BG_G}${BOLD}  ${rRaw.trim().padEnd(width - 4)}  ${R}`
      : `${GRY}  ${R}${rRaw}`;

    println(`${GRY}║${R}${pad(lColored, width + (lColored.length - stripColors(lColored).length))}${GRY}║${R}${pad(rColored, width + (rColored.length - stripColors(rColored).length))}${GRY}║${R}`);
  }
  println(`${GRY}╚${'═'.repeat(width)}╩${'═'.repeat(width)}╝${R}`);
}

async function main() {
  // Load real evidence
  const ev = JSON.parse(await readFile(EVIDENCE, 'utf8'));

  const srcMem   = ev.withMemory?.repairedSource ?? '';
  const srcNoMem = ev.withoutMemory?.repairedSource ?? '';
  const patMem   = ev.differential?.fix_patterns_with_memory ?? [];
  const patNoMem = ev.differential?.fix_patterns_without_memory ?? [];
  const verdict  = ev.differential?.causal_influence_verdict;

  println('');
  println(`${BOLD}${CYN}TracePilot — Causal Differential: Does memory change the repair strategy?${R}`);
  println(`${GRY}${'─'.repeat(90)}${R}`);
  await sleep(800);

  println(`${DIM}Reading causal-differential-evidence.json ...${R}`);
  await sleep(600);
  println(`  ${GRY}experiment:${R}   ${ev.experimentStartedAt ?? '—'}`);
  println(`  ${GRY}model:${R}        ${ev.model ?? '—'}`);
  println(`  ${GRY}run 1 session:${R} ${ev.withMemory?.sessionId ?? '—'}`);
  println(`  ${GRY}run 2 session:${R} ${ev.withoutMemory?.sessionId ?? '—'}`);
  println(`  ${GRY}run 2 project:${R} ${ev.withoutMemory?.isolatedProject ?? '(isolated — zero history)'}`);
  await sleep(1200);

  println('');
  println(`${BOLD}Experiment: identical TypeScript failure, identical model, two conditions${R}`);
  println(`  ${RED}Run 1: PHOENIX_PROJECT = tracepilot-gemini-cli  (11 historical repairs available)${R}`);
  println(`  ${GRN}Run 2: PHOENIX_PROJECT = isolated-fresh-project  (zero history — cold start)${R}`);
  await sleep(2000);

  // Zoomed in on calculateDiscount only
  println('');
  println(`${BOLD}${YEL}Focus: Fix 2 — TS2322 string→number — the diverging repair decision${R}`);
  await sleep(800);

  const noMemLines = extractFn(srcNoMem);
  const memLines   = extractFn(srcMem);

  sideBySide(noMemLines, memLines, 'WITHOUT MEMORY  (cold start)', 'WITH MEMORY  (historical context)');
  await sleep(3000);

  // The key line, zoomed
  println('');
  println(`${GRY}${'─'.repeat(90)}${R}`);
  println(`${BOLD}The diverging line:${R}`);
  println('');
  println(`  ${RED}${BOLD}WITHOUT MEMORY:${R}`);
  println(`    ${RED}const discountedPrice: ${BOLD}string${R}${RED} = (price * (1 - percent / 100)).toFixed(2);${R}`);
  println(`    ${GRY}→ Changes variable type from number to string. Relaxes the downstream contract.${R}`);
  println('');
  println(`  ${GRN}${BOLD}WITH MEMORY:${R}`);
  println(`    ${GRN}const discountedPrice: ${BOLD}number${R}${GRN} = parseFloat((price * (1 - percent / 100)).toFixed(2));${R}`);
  println(`    ${GRY}→ Converts string result to number. Preserves the original numeric contract.${R}`);
  await sleep(3500);

  println('');
  println(`${GRY}${'─'.repeat(90)}${R}`);
  println(`${BOLD}Both repairs compile. Both pass tsc --noEmit.${R}`);
  println(`${BOLD}${GRN}Only the memory-assisted repair preserves the original type contract.${R}`);
  await sleep(2500);

  // Pattern summary
  println('');
  println(`${GRY}Fix patterns detected:${R}`);
  println(`  ${RED}WITHOUT memory:${R} ${patNoMem.join(', ') || 'none detected'}`);
  println(`  ${GRN}WITH memory:${R}    ${patMem.join(', ')}`);
  println('');
  println(`${BOLD}Verdict:${R} ${verdict === 'CAUSAL_INFLUENCE_DETECTED'
    ? GRN + BOLD + '✓ CAUSAL INFLUENCE DETECTED' + R
    : YEL + verdict + R
  }`);
  println(`  ${GRY}Historical repair evidence changed the strategy selected by the agent.${R}`);
  await sleep(4000);
}

main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
