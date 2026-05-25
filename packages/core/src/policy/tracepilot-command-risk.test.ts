/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { classifyTracePilotCommandRisk } from './tracepilot-command-risk.js';

describe('TracePilot command risk model', () => {
  it.each([
    ['pwd', 'low'],
    ['ls -la', 'low'],
    ['cat package.json', 'low'],
    ['npm test', 'low'],
    ['npm run build', 'low'],
    ['npm install', 'medium'],
    ['npm run format', 'medium'],
    ['npm run lint:fix', 'medium'],
    ['git push origin main', 'high'],
    ['chmod -R 777 .', 'high'],
    ['npm run deploy', 'high'],
    ['rm -rf ./dist', 'high'],
    ['rm -rf /', 'blocked'],
    ['rm -rf ~', 'blocked'],
    ['cat .env', 'blocked'],
    ['Get-Content .env', 'blocked'],
    ['printenv', 'blocked'],
    ['env', 'blocked'],
    ['rg -n "api_key|password" .', 'blocked'],
    ['npm test && git push origin main', 'high'],
    ['npm test; cat .env', 'blocked'],
    ['echo ok | Select-String -Pattern "token"', 'blocked'],
    ['powershell -Command "Get-Content .env"', 'blocked'],
    ['pwsh -Command "Remove-Item -Recurse -Force C:\\"', 'blocked'],
    ['powershell -EncodedCommand SQBFAFgA', 'high'],
    ['cmd /c type .env', 'blocked'],
    ['Remove-Item -Recurse -Force ./dist', 'high'],
    ['ri -r -fo $HOME', 'blocked'],
    ['del /s /q C:\\Users', 'blocked'],
    ['Get-ChildItem Env:', 'blocked'],
    ['gci env:', 'blocked'],
    ['gc .env.local', 'blocked'],
  ] as const)('classifies %s as %s', (command, expected) => {
    expect(classifyTracePilotCommandRisk(command).level).toBe(expected);
  });
});
