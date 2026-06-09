/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * CLIP 1 — Real TypeScript failure on Project B
 * Duration target: ~12 seconds
 * Shows: tsc --noEmit → TS2322 errors
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PROJECT_B = resolve(ROOT, '.ai-logs/tracepilot-independent-eval/repair-memory-demo/project-b');

const R  = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED  = '\x1b[31m';
const YEL  = '\x1b[33m';
const CYN  = '\x1b[36m';
const GRY  = '\x1b[90m';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const print = s => process.stdout.write(s);
const println = s => process.stdout.write(s + '\n');

async function main() {
  // Ensure Project B is in its broken state
  const BROKEN = `// Project B: Inventory management service
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
  await writeFile(resolve(PROJECT_B, 'src/inventory.ts'), BROKEN, 'utf8');
  // Show context
  println('');
  println(`${BOLD}${CYN}tracepilot-gemini-cli / .ai-logs / repair-memory-demo / project-b${R}`);
  println(`${GRY}─────────────────────────────────────────────────────────────────${R}`);
  await sleep(800);

  // Show the broken source
  println(`${DIM}$ cat src/inventory.ts${R}`);
  await sleep(400);
  const src = await readFile(resolve(PROJECT_B, 'src/inventory.ts'), 'utf8');
  println(src
    .replace(/(const productTitle: string = getProductTitle.*)/g, `${RED}$1${R}`)
    .replace(/(const discountedPrice: number = .*toFixed.*)/g, `${RED}$1${R}`)
  );
  await sleep(1000);

  // Run real tsc
  println(`${DIM}$ npx tsc --noEmit${R}`);
  await sleep(300);

  const tscCmd = existsSync(resolve(PROJECT_B, 'node_modules/.bin/tsc.cmd'))
    ? resolve(PROJECT_B, 'node_modules/.bin/tsc.cmd')
    : null;

  await new Promise(res => {
    const args = tscCmd ? [tscCmd, '--noEmit'] : ['npx', 'tsc', '--noEmit'];
    const proc = spawn(args[0], args.slice(1), {
      cwd: PROJECT_B,
      shell: true,
      env: { ...process.env },
      windowsHide: false,
    });

    proc.stdout.on('data', d => {
      const text = d.toString()
        .replace(/(error TS\d+)/g, `${BOLD}${RED}$1${R}`)
        .replace(/(inventory\.ts\(\d+,\d+\))/g, `${YEL}$1${R}`);
      print(text);
    });
    proc.stderr.on('data', d => print(d.toString()));
    proc.on('close', code => {
      println('');
      if (code !== 0) {
        println(`${BOLD}${RED}✗ tsc --noEmit exited ${code} — TypeScript type errors detected${R}`);
      }
      res();
    });
  });

  await sleep(2000);
}

main().catch(e => { console.error(e); process.exit(1); });
