#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  runTracePilotEvals,
  type TracePilotEvalEvidence,
} from '../packages/core/src/tracepilot/evals.js';

interface CliOptions {
  input?: string;
  output?: string;
  pretty: boolean;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options.input) {
    console.error(
      'Usage: npm run eval:tracepilot -- --input <evidence.json> [--output <result.json>] [--pretty]',
    );
    return 2;
  }

  let evidence: TracePilotEvalEvidence;
  try {
    evidence = JSON.parse(
      await readFile(options.input, 'utf8'),
    ) as unknown as TracePilotEvalEvidence;
  } catch (error) {
    console.error(
      `Failed to read TracePilot eval evidence from ${options.input}: ${getErrorMessage(error)}`,
    );
    return 2;
  }

  const report = runTracePilotEvals(evidence);
  const json = JSON.stringify(report, null, options.pretty ? 2 : 0);
  if (options.output) {
    await writeFile(options.output, `${json}\n`, 'utf8');
  } else {
    console.log(json);
  }
  return report.ok ? 0 : 1;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { pretty: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--input') {
      options.input = argv[++index];
    } else if (arg === '--output') {
      options.output = argv[++index];
    } else if (arg === '--pretty') {
      options.pretty = true;
    }
  }
  return options;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
