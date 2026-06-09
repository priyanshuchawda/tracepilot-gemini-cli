// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable no-console */

// serve-dashboard.js — local HTTP server for the TracePilot live dashboard
// Serves the dashboard at http://localhost:3456
// Reads the latest comparison-report.json automatically, no restart needed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const phaseRoot = path.resolve(
  __dirname,
  '.ai-logs/tracepilot-independent-eval/phase2-nextjs',
);
const agentRunsRoot = path.join(phaseRoot, 'agent-runs');
const dashboardHtml = path.join(
  __dirname,
  '.ai-logs/tracepilot-independent-eval/hackathon-dashboard/dashboard-live.html',
);
const PORT = 3456;

function getLatestReportPath() {
  // 1. Try the pointer file written by run-agent-comparison.mjs
  const pointerFile = path.join(phaseRoot, 'latest-agent-comparison.txt');
  if (fs.existsSync(pointerFile)) {
    const p = fs.readFileSync(pointerFile, 'utf8').trim();
    if (fs.existsSync(p)) return p;
  }
  // 2. Fall back: scan agent-runs/ for newest dir with a comparison-report.json
  if (!fs.existsSync(agentRunsRoot)) return null;
  const dirs = fs
    .readdirSync(agentRunsRoot)
    .map((name) => ({ name, full: path.join(agentRunsRoot, name) }))
    .filter((d) => {
      try {
        return fs.statSync(d.full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const dir of dirs) {
    const rp = path.join(dir.full, 'comparison-report.json');
    if (fs.existsSync(rp)) return rp;
  }
  return null;
}

function getReport() {
  const rp = getLatestReportPath();
  if (!rp) return null;
  try {
    return JSON.parse(fs.readFileSync(rp, 'utf8'));
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (reqUrl.pathname === '/api/report') {
    const report = getReport();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(report ?? { _empty: true }));
    return;
  }

  // Serve dashboard HTML for all other routes
  try {
    const html = fs.readFileSync(dashboardHtml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end('Dashboard file not found: ' + dashboardHtml);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  TracePilot Live Dashboard');
  console.log('  ─────────────────────────────────────');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Dashboard auto-refreshes every 5 seconds.');
  console.log('  Run the benchmark in another terminal:');
  console.log(
    '  node .ai-logs/tracepilot-independent-eval/phase2-nextjs/run-agent-comparison.mjs',
  );
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Auto-open browser
  try {
    execSync(`start http://localhost:${PORT}`, { stdio: 'ignore', shell: true });
  } catch {
    // Non-fatal — user can open manually
  }
});
