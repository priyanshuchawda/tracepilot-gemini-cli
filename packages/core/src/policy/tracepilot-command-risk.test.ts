/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  classifyTracePilotCommandRisk,
  classifyTracePilotCommandRiskWithParser,
} from './tracepilot-command-risk.js';

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

  it.each([
    ['cat .env', 'credential_exposure'],
    ['npm test && cat .env', 'credential_exposure'],
    ['powershell -Command "Get-Content .env"', 'credential_exposure'],
    ['cmd /c type .env', 'credential_exposure'],
    ['npm exec -- cat .env', 'credential_exposure'],
    ['npx --yes sh -c "cat .env"', 'credential_exposure'],
    ['node -e "console.log(process.env)"', 'credential_exposure'],
    ['cat package.json > .env', 'credential_exposure'],
    ['rm -rf /', 'protected_recursive_delete'],
    [
      'pwsh -Command "Remove-Item -Recurse -Force $HOME"',
      'protected_recursive_delete',
    ],
    ['git push origin main', 'remote_mutation'],
    ['powershell -EncodedCommand SQBFAFgA', 'encoded_command'],
    ['npm run deploy', 'deployment_mutation'],
    ['chmod -R 777 .', 'permission_mutation'],
    ['rm -rf ./dist', 'local_recursive_delete'],
    ['npm test', 'read_only_or_verification'],
    ['npm ci', 'local_mutation_or_script'],
    ['npx vitest', 'read_only_or_verification'],
  ] as const)('returns stable reason code for %s', (command, reasonCode) => {
    expect(classifyTracePilotCommandRisk(command).reasonCode).toBe(reasonCode);
  });

  it.each([
    'npm test && cat .env',
    'cmd /c type .env',
    'powershell -Command "Get-Content .env"',
    'npm exec -- cat .env',
    'npx --yes sh -c "cat .env"',
  ])('reports parsed command details for %s', (command) => {
    const result = classifyTracePilotCommandRisk(command);
    expect(result.parsedCommands?.length).toBeGreaterThan(1);
    expect(
      result.parsedCommands
        ?.map((detail) => detail.commandName)
        .some((name) => ['cat', 'type', 'get-content'].includes(name)),
    ).toBe(true);
  });

  it('fails closed with a stable code for syntactically uncertain shell input', () => {
    const result = classifyTracePilotCommandRisk('git log &&& npm test');

    expect(result.level).toBe('high');
    expect(result.reasonCode).toBe('parse_error');
  });

  it('fails closed when the structured command parser throws', () => {
    const result = classifyTracePilotCommandRiskWithParser('npm test', () => {
      throw new Error('parser unavailable');
    });

    expect(result.level).toBe('high');
    expect(result.reasonCode).toBe('parse_error');
    expect(result.parsedCommands).toEqual([
      {
        commandName: 'npm',
        text: 'npm test',
        args: ['test'],
        source: 'fallback',
      },
    ]);
  });

  it('keeps blocked-command precedence when the parser throws', () => {
    const result = classifyTracePilotCommandRiskWithParser(
      'npm test && cat .env',
      () => {
        throw new Error('parser unavailable');
      },
    );

    expect(result.level).toBe('blocked');
    expect(result.reasonCode).toBe('credential_exposure');
    expect(
      result.parsedCommands
        ?.map((detail) => detail.commandName)
        .some((name) => name === 'cat'),
    ).toBe(true);
  });
});
