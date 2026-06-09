#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.cwd();
const output = path.resolve(
  process.argv[2] ??
    '.ai-logs/tracepilot-independent-eval/videos/nextjs-five-issue-terminal-run.mp4',
);
const model = process.env.TRACEPILOT_BENCHMARK_MODEL ?? 'gemini-3.1-flash-lite-preview';
const timeoutMs = process.env.TRACEPILOT_BENCHMARK_TIMEOUT_MS ?? '300000';
const holdSeconds = Number.parseInt(process.env.TRACEPILOT_RECORD_FINAL_HOLD_SECONDS ?? '35', 10);
const pwshPath = process.env.PWSH_PATH ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const ffmpegPath =
  process.env.FFMPEG_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const ffprobePath =
  process.env.FFPROBE_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe';

const capturePath = output.replace(/\.mp4$/i, '.capture.mkv');
await mkdir(path.dirname(output), { recursive: true });
await unlink(output).catch(() => undefined);
await unlink(capturePath).catch(() => undefined);

const terminalCommand = [
  `$env:TRACEPILOT_BENCHMARK_ARMS = 'blind,tracepilot'`,
  `$env:TRACEPILOT_BENCHMARK_MODEL = ${psQuote(model)}`,
  `$env:TRACEPILOT_BENCHMARK_TIMEOUT_MS = ${psQuote(timeoutMs)}`,
  'Clear-Host',
  "$host.UI.RawUI.WindowTitle = 'TracePilot Five-Issue Live Benchmark'",
  "Write-Host 'TracePilot vs Gemini CLI: five closed Next.js issues' -ForegroundColor Cyan",
  "Write-Host 'Recording from issue prep through final verifier results.' -ForegroundColor Cyan",
  "Write-Host ('Model: ' + $env:TRACEPILOT_BENCHMARK_MODEL)",
  "Write-Host 'Runner: scripts\\run-nextjs-five-issue-comparison.mjs'",
  "Write-Host 'Secret key is loaded in process env and is not printed.' -ForegroundColor DarkGray",
  "Write-Host ''",
  'node scripts\\run-nextjs-five-issue-comparison.mjs',
  '$exitCode = $LASTEXITCODE',
  "Write-Host ''",
  "Write-Host ('Comparison exit code: ' + $exitCode) -ForegroundColor Yellow",
  "Write-Host 'Latest report pointer:' -ForegroundColor Yellow",
  'Get-Content .ai-logs\\tracepilot-independent-eval\\phase3-nextjs-five\\latest-agent-comparison.txt -ErrorAction SilentlyContinue',
  "Write-Host ''",
  "Write-Host 'Building clean dashboard...' -ForegroundColor Cyan",
  'node scripts\\build-nextjs-five-dashboard.mjs',
  `Write-Host 'Holding final terminal frame for ${holdSeconds}s...' -ForegroundColor DarkGray`,
  `Start-Sleep -Seconds ${holdSeconds}`,
  'exit $exitCode',
].join('; ');

console.log(`recording desktop to ${capturePath}`);
const ffmpeg = spawn(
  ffmpegPath,
  [
    '-y',
    '-f',
    'gdigrab',
    '-framerate',
    '6',
    '-i',
    'desktop',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    capturePath,
  ],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
);
let ffmpegStderr = '';
ffmpeg.stderr.on('data', (chunk) => {
  ffmpegStderr += chunk.toString();
});

await wait(2500);
console.log('launching visible benchmark terminal');
const launcher = spawn(
  pwshPath,
  [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      '$process = Start-Process',
      '-FilePath',
      psQuote(pwshPath),
      '-WorkingDirectory',
      psQuote(workspace),
      '-ArgumentList',
      `@('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command',${psQuote(terminalCommand)})`,
      '-PassThru',
      '-Wait',
      '; exit $process.ExitCode',
    ].join(' '),
  ],
  { cwd: workspace, stdio: 'inherit', windowsHide: true },
);
const exitCode = await waitForProcess(launcher);
console.log(`terminal comparison finished with exit ${exitCode}`);

if (!ffmpeg.killed) {
  ffmpeg.stdin.write('q');
  ffmpeg.stdin.end();
}
const captureExit = await waitForProcess(ffmpeg);
if (captureExit !== 0) {
  throw new Error(`ffmpeg capture exited with ${captureExit}: ${ffmpegStderr}`);
}

console.log('transcoding capture to mp4');
await run(ffmpegPath, [
  '-y',
  '-i',
  capturePath,
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  output,
]);

const probe = await run(ffprobePath, [
  '-v',
  'error',
  '-show_entries',
  'format=duration,size:stream=codec_name,width,height',
  '-of',
  'json',
  output,
]);
const media = JSON.parse(probe.stdout);
console.log(
  JSON.stringify(
    {
      output,
      capture: capturePath,
      durationSeconds: Number(Number(media.format?.duration ?? 0).toFixed(2)),
      size: Number(media.format?.size ?? 0),
      stream: media.streams?.[0],
      comparisonExitCode: exitCode,
    },
    null,
    2,
  ),
);

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if ((code ?? 1) === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}
