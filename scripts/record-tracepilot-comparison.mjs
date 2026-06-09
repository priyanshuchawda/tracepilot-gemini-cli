/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.cwd();
const output =
  process.argv[2] ??
  path.join(
    workspace,
    '.ai-logs',
    'tracepilot-workbench',
    'tracepilot-comparison-demo.mp4',
  );
const prompt =
  process.argv[3] ??
  'A global billing platform double-charged an enterprise invoice after a cross-region webhook replay. Repair concurrency, retry, payload-conflict, risk-cache, and PII telemetry failures.';
const finalHoldMs = Number.parseInt(
  process.env['TRACEPILOT_RECORD_FINAL_HOLD_MS'] ?? '25000',
  10,
);
const recordMode = process.env['TRACEPILOT_RECORD_MODE'] ?? 'live';
const fakeAgentDelayMs =
  process.env['TRACEPILOT_FAKE_AGENT_DELAY_MS'] ?? '45000';

const edgePath =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ffmpegPath =
  process.env.FFMPEG_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const ffprobePath =
  process.env.FFPROBE_PATH ??
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe';
const debugPort = Number.parseInt(process.env.TRACEPILOT_RECORD_PORT ?? '9224');
const userDataDir = path.join(
  workspace,
  '.ai-logs',
  'tracepilot-workbench',
  'recording-edge-profile',
);

const frameDir = path.join(
  path.dirname(output),
  'tracepilot-comparison-frames',
);

await mkdir(path.dirname(output), { recursive: true });
await unlink(output).catch(() => undefined);
await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(userDataDir, { recursive: true });

const edge = spawn(
  edgePath,
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--app=http://127.0.0.1:4310',
    '--new-window',
    '--start-maximized',
    '--window-position=0,0',
    '--window-size=1600,1000',
  ],
  { stdio: 'ignore' },
);

let workbench;
let capture;
try {
  workbench = await ensureWorkbench();
  console.log('opening workbench in Edge');
  const client = await connectToWorkbench(debugPort);
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
  await client.command('Page.reload', { ignoreCache: true });
  await wait(2000);

  console.log('starting browser capture');
  capture = startBrowserCapture(client, frameDir);
  await wait(4500);
  console.log('starting comparison run');
  await evaluate(
    client,
    `
    document.querySelector('#new-run-button')?.click();
    document.querySelector('[data-mode="${recordMode}"]')?.click();
    const scenario = document.querySelector('#scenario-select');
    scenario.value = 'trace-ablation';
    scenario.dispatchEvent(new Event('change', { bubbles: true }));
  `,
  );
  await wait(5000);
  await evaluate(
    client,
    `
    const input = document.querySelector('#task-input');
    input.value = '';
    input.focus();
  `,
  );
  await typeText(client, prompt, 18);
  await wait(2500);
  await evaluate(client, `document.querySelector('#run-button').click();`);
  await wait(18000);
  await evaluate(
    client,
    `document.querySelector('#comparison-view')?.scrollTo({ top: 520, behavior: 'smooth' });`,
  );

  await waitForResult(client);
  await evaluate(
    client,
    `document.querySelector('#comparison-view')?.scrollTo({ top: 0, behavior: 'smooth' });`,
  );
  await wait(1500);
  console.log('comparison completed, holding final frame');
  await wait(finalHoldMs);

  const frameCount = await capture.stop();
  capture = undefined;

  console.log(`assembling ${frameCount} browser frames into mp4`);
  await run(ffmpegPath, [
    '-y',
    '-framerate',
    '1.5',
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
  const duration = Number(media.format?.duration ?? 0);
  const size = Number(media.format?.size ?? 0);
  if (!Number.isFinite(duration) || duration < 60 || size < 50_000) {
    throw new Error(`Recorded file did not verify: ${probe.stdout}`);
  }

  console.log(
    JSON.stringify(
      {
        output,
        durationSeconds: Number(duration.toFixed(2)),
        size,
        stream: media.streams?.[0],
      },
      null,
      2,
    ),
  );
} finally {
  await capture?.stop().catch(() => undefined);
  edge.kill();
  workbench?.kill();
}

async function ensureWorkbench() {
  if (process.env['TRACEPILOT_RECORD_REUSE_SERVER'] === 'true') {
    try {
      const response = await fetch('http://127.0.0.1:4310/api/status', {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        return undefined;
      }
    } catch {
      // Start a server owned by this recording process.
    }
  }

  console.log('starting workbench server');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/tracepilot-workbench-server.ts'],
    {
      cwd: workspace,
      env: { ...process.env, TRACEPILOT_FAKE_AGENT_DELAY_MS: fakeAgentDelayMs },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(
          `Workbench server exited with ${child.exitCode}: ${stderr}`,
        );
      }
      const response = await fetch('http://127.0.0.1:4310/api/status', {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    }, 20_000);
    return child;
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function connectToWorkbench(port) {
  const page = await waitFor(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json`).then(
      (response) => response.json(),
    );
    return pages.find((candidate) =>
      candidate.url.startsWith('http://127.0.0.1:4310'),
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
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(message.error);
    } else {
      waiter.resolve(message.result);
    }
  });

  return {
    command(method, params = {}) {
      const id = ++commandId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
  };
}

async function evaluate(client, expression) {
  return client.command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
}

async function typeText(client, text, delayMs) {
  for (const character of text) {
    await client.command('Input.insertText', { text: character });
    await wait(delayMs);
  }
}

function startBrowserCapture(client, directory) {
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
      await wait(200);
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

async function waitForResult(client) {
  await waitFor(async () => {
    const result = await evaluate(
      client,
      `JSON.stringify({
        disabled: document.querySelector('#run-button')?.disabled,
        verdict: document.querySelector('#comparison-summary-verdict')?.textContent,
        blind: document.querySelector('#summary-blind-score')?.textContent,
        trace: document.querySelector('#summary-trace-score')?.textContent
      })`,
    );
    const state = JSON.parse(result.result.value);
    return (
      state.disabled === false &&
      state.verdict &&
      state.verdict !== 'Awaiting both agents' &&
      state.blind !== '—' &&
      state.trace !== '—'
    );
  }, 160_000);
}

async function waitFor(callback, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError ?? new Error(`Timed out after ${timeoutMs}ms.`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
      }
    });
  });
}
