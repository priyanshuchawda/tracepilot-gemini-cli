#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { validateTracePilotJudgeResult } from '../packages/core/src/tracepilot/judgeEvidence.js';
import { validateTracePilotEvalReport } from '../packages/core/src/tracepilot/evals.js';
import { validateTracePilotRepairArtifact } from '../packages/core/src/tracepilot/repairReport.js';
import { redactSensitiveText } from '../packages/core/src/telemetry/sanitize.js';
import { writeTracePilotJudgeArtifacts } from './tracepilot-judge-artifacts.js';

interface CliOptions {
  repairArtifact?: string;
  evalReport?: string;
  judgeInputOutput?: string;
  judgeResultInput?: string;
  judgeResultOutput?: string;
  unavailableReason: string;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (
    !options.repairArtifact ||
    !options.evalReport ||
    !options.judgeInputOutput ||
    !options.judgeResultOutput
  ) {
    console.error(
      [
        'Usage: npm run judge:tracepilot --',
        '--repair-artifact <repair.json>',
        '--eval-report <eval-report.json>',
        '--judge-input-output <judge-input.json>',
        '--judge-result-output <judge-result.json>',
        '[--judge-result-input <scored-result.json>]',
        '[--unavailable-reason <reason>]',
      ].join(' '),
    );
    return 2;
  }

  try {
    const repair = validateTracePilotRepairArtifact(
      await readJsonFile(options.repairArtifact),
    );
    const deterministicEval = validateTracePilotEvalReport(
      await readJsonFile(options.evalReport),
    );
    const judgeResult = options.judgeResultInput
      ? validateTracePilotJudgeResult(
          await readJsonFile(options.judgeResultInput),
        )
      : undefined;
    const artifacts = await writeTracePilotJudgeArtifacts({
      repairArtifact: repair,
      evalReport: deterministicEval,
      judgeInputOutput: options.judgeInputOutput,
      judgeResultOutput: options.judgeResultOutput,
      judgeResult,
      unavailableReason: options.unavailableReason,
    });

    console.log(`TracePilot judge input: ${artifacts.inputPath}`);
    console.log(`TracePilot judge result: ${artifacts.resultPath}`);
    console.log(
      `JUDGE_MODE: ${artifacts.result.mode} strictLiveProof=${artifacts.result.strictLiveProof}`,
    );
    return artifacts.result.ok ? 0 : 1;
  } catch (error) {
    console.error(
      `Failed to write TracePilot judge evidence: ${redact(getErrorMessage(error))}`,
    );
    return 2;
  }
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    unavailableReason:
      'Repair-quality judge execution was not configured for this run.',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--repair-artifact') {
      options.repairArtifact = argv[++index];
    } else if (arg === '--eval-report') {
      options.evalReport = argv[++index];
    } else if (arg === '--judge-input-output') {
      options.judgeInputOutput = argv[++index];
    } else if (arg === '--judge-result-input') {
      options.judgeResultInput = argv[++index];
    } else if (arg === '--judge-result-output') {
      options.judgeResultOutput = argv[++index];
    } else if (arg === '--unavailable-reason') {
      options.unavailableReason = argv[++index] ?? options.unavailableReason;
    }
  }
  return options;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string): string {
  return redactSensitiveText(value).value;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
