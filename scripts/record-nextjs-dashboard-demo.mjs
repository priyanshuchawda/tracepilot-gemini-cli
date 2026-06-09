#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const workspace = process.cwd();
const output = path.resolve(
  process.argv[2] ??
    '.ai-logs/tracepilot-independent-eval/videos/nextjs-clean-dashboard-demo.mp4',
);
const dashboardPath = path.resolve(
  process.env.TRACEPILOT_DASHBOARD_PATH ??
    '.ai-logs/tracepilot-independent-eval/hackathon-dashboard/index.html',
);
const dashboardUrl = pathToFileURL(dashboardPath).href;
const frameDir = output.replace(/\.mp4$/i, '-frames');
const userDataDir = path.join(
  workspace,
  '.ai-logs',
  'tracepilot-independent-eval',
  'dashboard-edge-profile',
);
const edgePath =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ffmpegPath =
  process.env.FFMPEG_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const ffprobePath =
  process.env.FFPROBE_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe';
const debugPort = Number.parseInt(
  process.env.TRACEPILOT_DASHBOARD_RECORD_PORT ?? '9237',
  10,
);

await mkdir(path.dirname(output), { recursive: true });
await unlink(output).catch(() => undefined);
await rm(frameDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
await mkdir(userDataDir, { recursive: true });

const edge = spawn(
  edgePath,
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--new-window',
    '--window-size=1366,768',
    '--window-position=0,0',
    dashboardUrl,
  ],
  { windowsHide: true, stdio: 'ignore' },
);

try {
  const client = await connectToPage(debugPort);
  await client.command('Page.enable');
  await client.command('Runtime.enable');
  await client.command('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1366,
    screenHeight: 768,
  });
  await wait(1200);

  const capture = startCapture(client, frameDir);
  await wait(6000);
  await scrollTo(client, 0, 5000);
  await scrollTo(client, 430, 7000);
  await scrollTo(client, 850, 7000);
  await scrollTo(client, 1250, 7000);
  await openMoreInfo(client);
  await wait(8000);
  await scrollTo(client, 1700, 7000);
  await scrollTo(client, 0, 6000);
  const frames = await capture.stop();

  await run(ffmpegPath, [
    '-y',
    '-framerate',
    '2',
    '-i',
    path.join(frameDir, 'frame-%05d.png'),
    '-r',
    '30',
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
        frames,
        durationSeconds: Number(Number(media.format?.duration ?? 0).toFixed(2)),
        size: Number(media.format?.size ?? 0),
        stream: media.streams?.[0],
      },
      null,
      2,
    ),
  );
} finally {
  edge.kill();
}

function startCapture(client, directory) {
  let stopped = false;
  let frame = 0;
  const loop = (async () => {
    while (!stopped) {
      const screenshot = await client.command('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      frame += 1;
      await writeFile(
        path.join(directory, `frame-${String(frame).padStart(5, '0')}.png`),
        Buffer.from(screenshot.data, 'base64'),
      );
      await wait(500);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return frame;
    },
  };
}

async function scrollTo(client, top, holdMs) {
  await client.command('Runtime.evaluate', {
    expression: `window.scrollTo({ top: ${top}, behavior: 'smooth' });`,
  });
  await wait(holdMs);
}

async function openMoreInfo(client) {
  await client.command('Runtime.evaluate', {
    expression: `document.querySelector('details')?.setAttribute('open', '');`,
  });
}

async function connectToPage(port) {
  const page = await waitFor(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json`).then((res) =>
      res.json(),
    );
    return pages.find((candidate) =>
      candidate.url.includes('hackathon-dashboard'),
    );
  }, 20_000);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  return {
    command(method, params = {}) {
      commandId += 1;
      socket.send(JSON.stringify({ id: commandId, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(commandId, { resolve, reject });
      });
    },
  };
}

async function waitFor(fn, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(400);
  }
  throw lastError ?? new Error('Timed out waiting for page');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
