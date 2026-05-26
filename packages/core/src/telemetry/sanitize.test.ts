/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for telemetry sanitization functions.
 *
 * This test file focuses on validating PII protection through sanitization,
 * particularly for hook names that may contain sensitive information like
 * API keys, credentials, file paths, and command arguments.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { HookCallEvent, EVENT_HOOK_CALL } from './types.js';
import { HookType } from '../hooks/types.js';
import type { Config } from '../config/config.js';
import {
  createRedactedOutputPreview,
  redactSensitiveText,
} from './sanitize.js';

const REDACTION_CORPUS = [
  {
    name: 'gemini api key',
    input: 'GEMINI_API_KEY=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY12',
    forbidden: ['AIzaSyDUMMY'],
  },
  {
    name: 'openai project key',
    input: 'OPENAI_API_KEY=sk-proj-dummyDummyDummyDummyDummyDummy',
    forbidden: ['sk-proj-dummy'],
  },
  {
    name: 'github classic token',
    input: 'GITHUB_TOKEN=ghp_dummyDummyDummyDummyDummyDummyDummy12',
    forbidden: ['ghp_dummy'],
  },
  {
    name: 'github oauth token',
    input: 'gho_dummyDummyDummyDummyDummyDummyDummy12',
    forbidden: ['gho_dummy'],
  },
  {
    name: 'github user token',
    input: 'ghu_dummyDummyDummyDummyDummyDummyDummy12',
    forbidden: ['ghu_dummy'],
  },
  {
    name: 'github server token',
    input: 'ghs_dummyDummyDummyDummyDummyDummyDummy12',
    forbidden: ['ghs_dummy'],
  },
  {
    name: 'github refresh token',
    input: 'ghr_dummyDummyDummyDummyDummyDummyDummy12',
    forbidden: ['ghr_dummy'],
  },
  {
    name: 'github fine grained token',
    input: 'github_pat_dummyDummyDummyDummyDummyDummyDummy12',
    forbidden: ['github_pat_dummy'],
  },
  {
    name: 'gitlab token',
    input: 'GITLAB_TOKEN=glpat-1234567890abcdefghijkl',
    forbidden: ['glpat-1234567890'],
  },
  {
    name: 'slack token',
    input: [
      'SLACK_BOT_TOKEN=xoxb',
      '123456789012',
      '123456789012',
      'abcdefghijklmnop',
    ].join('-'),
    forbidden: ['xoxb-123456789012'],
  },
  {
    name: 'aws access key',
    input: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    forbidden: ['AKIAIOSFODNN7EXAMPLE'],
  },
  {
    name: 'aws secret key',
    input: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    forbidden: ['wJalrXUtnFEMI'],
  },
  {
    name: 'jwt',
    input:
      'JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    forbidden: ['eyJhbGciOiJIUzI1NiI'],
  },
  {
    name: 'authorization header',
    input: 'Authorization: Bearer abc.def.ghi',
    forbidden: ['abc.def.ghi'],
  },
  {
    name: 'database url env',
    input: 'DATABASE_URL=postgres://user:pass@example.com/db',
    forbidden: ['postgres://user:pass', 'pass@example.com'],
  },
  {
    name: 'redis url credential',
    input: 'REDIS_URL=redis://default:redis-password@example.com:6379/0',
    forbidden: ['redis-password'],
  },
  {
    name: 'inline url credential',
    input: 'fetch https://service-user:service-pass@example.com/api',
    forbidden: ['service-user:service-pass'],
  },
  {
    name: 'quoted client secret',
    input: 'client_secret: "quoted-secret-value"',
    forbidden: ['quoted-secret-value'],
  },
  {
    name: 'private key block',
    input: [
      '-----BEGIN PRIVATE KEY-----',
      'private-key-material',
      '-----END PRIVATE KEY-----',
    ].join('\n'),
    forbidden: ['private-key-material'],
  },
];

/**
 * Create a mock config for testing.
 *
 * @param logPromptsEnabled Whether telemetry logging of prompts is enabled.
 * @returns Mock config object.
 */
function createMockConfig(logPromptsEnabled: boolean): Config {
  return {
    getTelemetryLogPromptsEnabled: () => logPromptsEnabled,
    getSessionId: () => 'test-session-id',
    getExperiments: () => undefined,
    getExperimentsAsync: async () => undefined,
    getModel: () => 'gemini-1.5-flash',
    isInteractive: () => true,
    getUserEmail: () => undefined,
    getContentGeneratorConfig: () => undefined,
  } as unknown as Config;
}

describe('Telemetry Sanitization', () => {
  describe('redactSensitiveText', () => {
    it('redacts common secret patterns before telemetry export', () => {
      const sensitive = [
        ...REDACTION_CORPUS.map((item) => item.input),
        'password="super-secret"',
        'api_key: plain-secret',
      ].join('\n');

      const result = redactSensitiveText(sensitive);

      expect(result.redacted).toBe(true);
      for (const item of REDACTION_CORPUS) {
        for (const forbidden of item.forbidden) {
          expect(result.value).not.toContain(forbidden);
        }
      }
      expect(result.value).not.toContain('super-secret');
      expect(result.value).not.toContain('plain-secret');
      expect(result.value).toContain('[REDACTED]');
    });

    it.each(REDACTION_CORPUS)(
      'redacts corpus fixture: $name',
      ({ input, forbidden }) => {
        const result = redactSensitiveText(input);

        expect(result.redacted).toBe(true);
        for (const value of forbidden) {
          expect(result.value).not.toContain(value);
        }
      },
    );

    it('leaves non-sensitive text unchanged', () => {
      const text = 'tests failed with exit code 1';

      expect(redactSensitiveText(text)).toEqual({
        value: text,
        redacted: false,
      });
    });
  });

  describe('createRedactedOutputPreview', () => {
    it('returns a hash and bounded redacted preview without leaking secrets', () => {
      const output = [
        'first line',
        'OPENAI_API_KEY=sk-proj-dummyDummyDummyDummyDummyDummy',
        'middle'.repeat(100),
        'Authorization: Bearer abc.def.ghi',
        'last line',
      ].join('\n');

      const preview = createRedactedOutputPreview(output, {
        headChars: 60,
        tailChars: 60,
      });

      expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(preview.sha256).not.toBe(
        createHash('sha256').update(output).digest('hex'),
      );
      expect(preview.fingerprintVersion).toBe('redacted-sha256-v1');
      expect(preview.originalLength).toBe(output.length);
      expect(preview.truncated).toBe(true);
      expect(preview.redacted).toBe(true);
      expect(preview.preview).toContain('[REDACTED]');
      expect(preview.preview).not.toContain('sk-proj-dummy');
      expect(preview.preview).not.toContain('abc.def.ghi');
      expect(preview.preview.length).toBeLessThanOrEqual(
        120 + '\n...[TRUNCATED OUTPUT]...\n'.length,
      );
    });

    it('redacts before truncating so boundary-split secrets cannot leak', () => {
      const secret = 'sk-proj-' + 'a'.repeat(80);
      const output = `prefix ${secret} suffix`;

      const preview = createRedactedOutputPreview(output, {
        headChars: 18,
        tailChars: 18,
      });

      expect(preview.redacted).toBe(true);
      expect(preview.preview).toContain('[REDACTED]');
      expect(preview.preview).not.toContain('sk-proj-');
      expect(preview.preview).not.toContain('aaaaaaaaaa');
    });

    it('uses the redacted full output for stable safe fingerprints', () => {
      const first = createRedactedOutputPreview(
        'OPENAI_API_KEY=sk-proj-firstSecret0000000000000000',
      );
      const second = createRedactedOutputPreview(
        'OPENAI_API_KEY=sk-proj-secondSecret000000000000000',
      );

      expect(first.sha256).toBe(second.sha256);
    });

    it('keeps corpus secrets out of previews and redacted fingerprints', () => {
      const output = REDACTION_CORPUS.map((item) => item.input).join('\n');
      const preview = createRedactedOutputPreview(output);

      expect(preview.redacted).toBe(true);
      expect(preview.fingerprintVersion).toBe('redacted-sha256-v1');
      expect(preview.sha256).toBe(
        createHash('sha256')
          .update(redactSensitiveText(output).value)
          .digest('hex'),
      );
      for (const item of REDACTION_CORPUS) {
        for (const forbidden of item.forbidden) {
          expect(preview.preview).not.toContain(forbidden);
        }
      }
    });
  });

  describe('HookCallEvent', () => {
    describe('constructor', () => {
      it('should create an event with all fields', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'test-hook',
          { tool_name: 'ReadFile' },
          100,
          true,
          { decision: 'allow' },
          0,
          'output',
          'error',
          undefined,
        );

        expect(event['event.name']).toBe('hook_call');
        expect(event.hook_event_name).toBe('BeforeTool');
        expect(event.hook_type).toBe('command');
        expect(event.hook_name).toBe('test-hook');
        expect(event.hook_input).toEqual({ tool_name: 'ReadFile' });
        expect(event.hook_output).toEqual({ decision: 'allow' });
        expect(event.exit_code).toBe(0);
        expect(event.stdout).toBe('output');
        expect(event.stderr).toBe('error');
        expect(event.duration_ms).toBe(100);
        expect(event.success).toBe(true);
        expect(event.error).toBeUndefined();
      });

      it('should create an event with minimal fields', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'test-hook',
          { tool_name: 'ReadFile' },
          100,
          true,
        );

        expect(event.hook_output).toBeUndefined();
        expect(event.exit_code).toBeUndefined();
        expect(event.stdout).toBeUndefined();
        expect(event.stderr).toBeUndefined();
        expect(event.error).toBeUndefined();
      });
    });

    describe('toOpenTelemetryAttributes with logPrompts=true', () => {
      const config = createMockConfig(true);

      it('should include all fields when logPrompts is enabled', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          '/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123',
          { tool_name: 'ReadFile', args: { file: 'secret.txt' } },
          100,
          true,
          { decision: 'allow' },
          0,
          'hook executed successfully',
          'no errors',
        );

        const attributes = event.toOpenTelemetryAttributes(config);

        expect(attributes['event.name']).toBe(EVENT_HOOK_CALL);
        expect(attributes['hook_event_name']).toBe('BeforeTool');
        expect(attributes['hook_type']).toBe('command');
        // With logPrompts=true, full hook name is included
        expect(attributes['hook_name']).toBe(
          '/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123',
        );
        expect(attributes['duration_ms']).toBe(100);
        expect(attributes['success']).toBe(true);
        expect(attributes['exit_code']).toBe(0);
        // PII-sensitive fields should be included
        expect(attributes['hook_input']).toBeDefined();
        expect(attributes['hook_output']).toBeDefined();
        expect(attributes['stdout']).toBe('hook executed successfully');
        expect(attributes['stderr']).toBe('no errors');
      });

      it('should include hook_input and hook_output as JSON strings', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'test-hook',
          { tool_name: 'ReadFile', args: { file: 'test.txt' } },
          100,
          true,
          { decision: 'allow', reason: 'approved' },
        );

        const attributes = event.toOpenTelemetryAttributes(config);

        // Should be JSON stringified
        // eslint-disable-next-line no-restricted-syntax
        expect(typeof attributes['hook_input']).toBe('string');
        // eslint-disable-next-line no-restricted-syntax
        expect(typeof attributes['hook_output']).toBe('string');

        const parsedInput = JSON.parse(attributes['hook_input'] as string);
        expect(parsedInput).toEqual({
          tool_name: 'ReadFile',
          args: { file: 'test.txt' },
        });

        const parsedOutput = JSON.parse(attributes['hook_output'] as string);
        expect(parsedOutput).toEqual({ decision: 'allow', reason: 'approved' });
      });
    });

    describe('toOpenTelemetryAttributes with logPrompts=false', () => {
      const config = createMockConfig(false);

      it('should exclude PII-sensitive fields when logPrompts is disabled', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          '/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123',
          { tool_name: 'ReadFile', args: { file: 'secret.txt' } },
          100,
          true,
          { decision: 'allow' },
          0,
          'hook executed successfully',
          'no errors',
        );

        const attributes = event.toOpenTelemetryAttributes(config);

        expect(attributes['event.name']).toBe(EVENT_HOOK_CALL);
        expect(attributes['hook_event_name']).toBe('BeforeTool');
        expect(attributes['hook_type']).toBe('command');
        expect(attributes['duration_ms']).toBe(100);
        expect(attributes['success']).toBe(true);
        expect(attributes['exit_code']).toBe(0);
        // PII-sensitive fields should NOT be included
        expect(attributes['hook_input']).toBeUndefined();
        expect(attributes['hook_output']).toBeUndefined();
        expect(attributes['stdout']).toBeUndefined();
        expect(attributes['stderr']).toBeUndefined();
      });

      it('should sanitize hook_name when logPrompts is disabled', () => {
        const testCases = [
          {
            input: '/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123',
            expected: 'check-secrets.sh',
            description: 'full path with arguments',
          },
          {
            input: 'python /home/user/script.py --token=xyz',
            expected: 'python',
            description: 'command with script path and token',
          },
          {
            input: 'node index.js',
            expected: 'node',
            description: 'simple command with file',
          },
          {
            input: '/usr/bin/bash -c "echo $SECRET"',
            expected: 'bash',
            description: 'path with inline script',
          },
          {
            input: 'C:\\Windows\\System32\\cmd.exe /c secret.bat',
            expected: 'cmd.exe',
            description: 'Windows path with arguments',
          },
          {
            input: './hooks/local-hook.sh',
            expected: 'local-hook.sh',
            description: 'relative path',
          },
          {
            input: 'simple-command',
            expected: 'simple-command',
            description: 'command without path or args',
          },
          {
            input: '',
            expected: 'unknown-command',
            description: 'empty string',
          },
          {
            input: '   ',
            expected: 'unknown-command',
            description: 'whitespace only',
          },
        ];

        for (const testCase of testCases) {
          const event = new HookCallEvent(
            'BeforeTool',
            HookType.Command,
            testCase.input,
            { tool_name: 'ReadFile' },
            100,
            true,
          );

          const attributes = event.toOpenTelemetryAttributes(config);

          expect(attributes['hook_name']).toBe(testCase.expected);
        }
      });

      it('should still include error field even when logPrompts is disabled', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'test-hook',
          { tool_name: 'ReadFile' },
          100,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          'Hook execution failed',
        );

        const attributes = event.toOpenTelemetryAttributes(config);

        // Error should be included for debugging
        expect(attributes['error']).toBe('Hook execution failed');
        // But other PII fields should not
        expect(attributes['hook_input']).toBeUndefined();
        expect(attributes['stdout']).toBeUndefined();
      });
    });

    describe('sanitizeHookName edge cases', () => {
      const config = createMockConfig(false);

      it('should handle commands with multiple spaces', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'python   script.py   --arg1   --arg2',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('python');
      });

      it('should handle mixed path separators', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          '/path/to\\mixed\\separators.sh',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('separators.sh');
      });

      it('should handle trailing slashes', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          '/path/to/directory/',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('unknown-command');
      });
    });

    describe('toLogBody', () => {
      it('should format success message correctly', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'test-hook',
          {},
          150,
          true,
        );

        expect(event.toLogBody()).toBe(
          'Hook call BeforeTool.test-hook succeeded in 150ms',
        );
      });

      it('should format failure message correctly', () => {
        const event = new HookCallEvent(
          'AfterTool',
          HookType.Command,
          'validation-hook',
          {},
          75,
          false,
        );

        expect(event.toLogBody()).toBe(
          'Hook call AfterTool.validation-hook failed in 75ms',
        );
      });
    });

    describe('integration scenarios', () => {
      it('should handle enterprise scenario with full logging', () => {
        const enterpriseConfig = createMockConfig(true);

        const event = new HookCallEvent(
          'BeforeModel',
          HookType.Command,
          '$GEMINI_PROJECT_DIR/.gemini/hooks/add-context.sh',
          {
            llm_request: {
              model: 'gemini-1.5-flash',
              messages: [{ role: 'user', content: 'Hello' }],
            },
          },
          250,
          true,
          {
            hookSpecificOutput: {
              llm_request: {
                messages: [
                  { role: 'user', content: 'Hello' },
                  { role: 'system', content: 'Additional context...' },
                ],
              },
            },
          },
          0,
          'Context added successfully',
        );

        const attributes = event.toOpenTelemetryAttributes(enterpriseConfig);

        // In enterprise mode, everything is logged
        expect(attributes['hook_name']).toBe(
          '$GEMINI_PROJECT_DIR/.gemini/hooks/add-context.sh',
        );
        expect(attributes['hook_input']).toBeDefined();
        expect(attributes['hook_output']).toBeDefined();
        expect(attributes['stdout']).toBe('Context added successfully');
      });

      it('should handle public telemetry scenario with minimal logging', () => {
        const publicConfig = createMockConfig(false);

        const event = new HookCallEvent(
          'BeforeModel',
          HookType.Command,
          '$GEMINI_PROJECT_DIR/.gemini/hooks/add-context.sh',
          {
            llm_request: {
              model: 'gemini-1.5-flash',
              messages: [{ role: 'user', content: 'Hello' }],
            },
          },
          250,
          true,
          {
            hookSpecificOutput: {
              llm_request: {
                messages: [
                  { role: 'user', content: 'Hello' },
                  { role: 'system', content: 'Additional context...' },
                ],
              },
            },
          },
          0,
          'Context added successfully',
        );

        const attributes = event.toOpenTelemetryAttributes(publicConfig);

        // In public mode, only metadata
        expect(attributes['hook_name']).toBe('add-context.sh');
        expect(attributes['hook_input']).toBeUndefined();
        expect(attributes['hook_output']).toBeUndefined();
        expect(attributes['stdout']).toBeUndefined();
        // But metadata is still there
        expect(attributes['hook_event_name']).toBe('BeforeModel');
        expect(attributes['duration_ms']).toBe(250);
        expect(attributes['success']).toBe(true);
      });
    });

    describe('real-world sensitive command examples', () => {
      const config = createMockConfig(false);

      it('should sanitize commands with API keys', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'curl https://api.example.com -H "Authorization: Bearer sk-abc123xyz"',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('curl');
      });

      it('should sanitize commands with database credentials', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'psql postgresql://user:password@localhost/db',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('psql');
      });

      it('should sanitize commands with environment variables containing secrets', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'AWS_SECRET_KEY=abc123 aws s3 ls',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('AWS_SECRET_KEY=abc123');
      });

      it('should sanitize Python scripts with file paths', () => {
        const event = new HookCallEvent(
          'BeforeTool',
          HookType.Command,
          'python /home/john.doe/projects/secret-scanner/scan.py --config=/etc/secrets.yml',
          {},
          100,
          true,
        );

        const attributes = event.toOpenTelemetryAttributes(config);
        expect(attributes['hook_name']).toBe('python');
      });
    });
  });
});
