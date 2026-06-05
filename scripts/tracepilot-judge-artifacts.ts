/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createTracePilotJudgeInput,
  createTracePilotJudgeUnavailableResult,
  stableTracePilotJudgeInputJson,
  stableTracePilotJudgeResultJson,
  validateTracePilotJudgeResult,
  type TracePilotJudgeResult,
} from '../packages/core/src/tracepilot/judgeEvidence.js';
import type { TracePilotEvalReport } from '../packages/core/src/tracepilot/evals.js';
import type { TracePilotRepairArtifact } from '../packages/core/src/tracepilot/repairReport.js';

export interface TracePilotJudgeArtifactWriteOptions {
  repairArtifact: TracePilotRepairArtifact;
  evalReport: TracePilotEvalReport;
  judgeInputOutput: string;
  judgeResultOutput: string;
  judgeResult?: TracePilotJudgeResult;
  unavailableReason: string;
}

export interface TracePilotJudgeArtifactSummary {
  inputPath: string;
  resultPath: string;
  result: TracePilotJudgeResult;
}

export function defaultTracePilotJudgeArtifactPaths(reportOutput: string): {
  judgeInputOutput: string;
  judgeResultOutput: string;
} {
  const outputDir = path.dirname(path.resolve(reportOutput));
  return {
    judgeInputOutput: path.join(outputDir, 'judge-input.json'),
    judgeResultOutput: path.join(outputDir, 'judge-result.json'),
  };
}

export async function writeTracePilotJudgeArtifacts(
  options: TracePilotJudgeArtifactWriteOptions,
): Promise<TracePilotJudgeArtifactSummary> {
  const judgeInput = createTracePilotJudgeInput({
    repair: options.repairArtifact,
    deterministicEval: options.evalReport,
  });
  const judgeResult =
    options.judgeResult === undefined
      ? createTracePilotJudgeUnavailableResult(options.unavailableReason)
      : validateTracePilotJudgeResult(options.judgeResult);

  await mkdir(path.dirname(path.resolve(options.judgeInputOutput)), {
    recursive: true,
  });
  await mkdir(path.dirname(path.resolve(options.judgeResultOutput)), {
    recursive: true,
  });
  await writeFile(
    options.judgeInputOutput,
    stableTracePilotJudgeInputJson(judgeInput),
    'utf8',
  );
  await writeFile(
    options.judgeResultOutput,
    stableTracePilotJudgeResultJson(judgeResult),
    'utf8',
  );

  return {
    inputPath: options.judgeInputOutput,
    resultPath: options.judgeResultOutput,
    result: judgeResult,
  };
}

export async function readTracePilotJudgeResultFile(
  file: string,
): Promise<TracePilotJudgeResult> {
  return validateTracePilotJudgeResult(
    JSON.parse(await readFile(file, 'utf8')) as unknown,
  );
}
