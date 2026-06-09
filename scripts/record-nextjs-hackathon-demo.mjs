#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const workspace = process.cwd();
const output = path.resolve(
  process.argv[2] ??
    '.ai-logs/tracepilot-independent-eval/videos/nextjs-hackathon-demo-footage.mp4',
);
const dashboardPath = path.resolve(
  '.ai-logs/tracepilot-independent-eval/hackathon-dashboard/index.html',
);
const dashboardUrl = pathToFileURL(dashboardPath).href;
const phoenixUrl =
  process.env.PHOENIX_HOST ??
  process.env.PHOENIX_BASE_URL ??
  process.env.PHOENIX_COLLECTOR_ENDPOINT ??
  '';
const pwshPath =
  process.env.PWSH_PATH ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const edgePath =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ffmpegPath =
  process.env.FFMPEG_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const ffprobePath =
  process.env.FFPROBE_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe';
await mkdir(path.dirname(output), { recursive: true });
await unlink(output).catch(() => undefined);

const ffmpeg = spawn(
  ffmpegPath,
  [
    '-y',
    '-f',
    'gdigrab',
    '-framerate',
    '5',
    '-i',
    'desktop',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
let ffmpegStderr = '';
ffmpeg.stderr.on('data', (chunk) => {
  ffmpegStderr += chunk.toString();
});

let terminal;
let edge;
try {
  await wait(1500);
  terminal = spawn(
    pwshPath,
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        "$host.UI.RawUI.WindowTitle = 'TracePilot Live Terminal Proof'",
        'Clear-Host',
        "Write-Host 'TracePilot terminal proof: real benchmark report, verifier exits, Gemini stream-json' -ForegroundColor Cyan",
        'node scripts\\show-nextjs-comparison-evidence.mjs --paced',
        "Write-Host ''; Write-Host 'Terminal proof complete. Switching to dashboard...' -ForegroundColor Yellow",
        'Start-Sleep -Seconds 20',
      ].join('; '),
    ],
    { cwd: workspace, windowsHide: false, stdio: 'ignore' },
  );
  await wait(75_000);

  edge = spawn(
    edgePath,
    [
      '--new-window',
      '--start-maximized',
      dashboardUrl,
    ],
    { windowsHide: false, stdio: 'ignore' },
  );
  await wait(10_000);
  await sendKeys('{PGDN}');
  await wait(12_000);
  await sendKeys('{PGDN}');
  await wait(12_000);
  await sendKeys('{PGDN}');
  await wait(12_000);
  await sendKeys('{HOME}');
  await wait(10_000);

  if (phoenixUrl) {
    spawn(edgePath, ['--new-window', '--start-maximized', phoenixUrl], {
      windowsHide: false,
      stdio: 'ignore',
    });
    await wait(18_000);
  } else {
    await sendKeys('{PGDN}');
    await sendKeys('{PGDN}');
    await wait(18_000);
  }
  await wait(5000);
} finally {
  terminal?.kill();
  edge?.kill();
  if (!ffmpeg.killed) {
    ffmpeg.stdin.write('q');
    ffmpeg.stdin.end();
  }
}

const captureExit = await waitForProcess(ffmpeg);
if (captureExit !== 0) {
  throw new Error(`ffmpeg exited with ${captureExit}: ${ffmpegStderr}`);
}
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
      durationSeconds: Number(Number(media.format?.duration ?? 0).toFixed(2)),
      size: Number(media.format?.size ?? 0),
      stream: media.streams?.[0],
      phoenixOpened: Boolean(phoenixUrl),
    },
    null,
    2,
  ),
);

async function sendKeys(keys) {
  await run(pwshPath, [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    `(New-Object -ComObject WScript.Shell).SendKeys('${keys}')`,
  ]);
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
