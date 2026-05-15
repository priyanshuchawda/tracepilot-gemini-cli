/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export const REDACTION_APPLIED_ATTRIBUTE = 'tracepilot.redaction.applied';
const REDACTED = '[REDACTED]';

export interface RedactionResult {
  value: string;
  redacted: boolean;
}

export interface OutputPreviewOptions {
  headChars?: number;
  tailChars?: number;
}

export interface RedactedOutputPreview {
  preview: string;
  sha256: string;
  originalLength: number;
  truncated: boolean;
  redacted: boolean;
}

const SECRET_PATTERNS: Array<{
  pattern: RegExp;
  replace: string | ((substring: string, ...args: string[]) => string);
}> = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  {
    pattern: /AIza[0-9A-Za-z_-]{20,}/g,
    replace: REDACTED,
  },
  {
    pattern: /sk-(?:proj-)?[0-9A-Za-z_-]{20,}/g,
    replace: REDACTED,
  },
  {
    pattern: /ghp_[0-9A-Za-z_]{20,}/g,
    replace: REDACTED,
  },
  {
    pattern: /github_pat_[0-9A-Za-z_]{20,}/g,
    replace: REDACTED,
  },
  {
    pattern: /\bAuthorization\s*:\s*[^\r\n]+/gi,
    replace: `Authorization: ${REDACTED}`,
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replace: `Bearer ${REDACTED}`,
  },
  {
    pattern: /\bDATABASE_URL\s*=\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replace: `DATABASE_URL=${REDACTED}`,
  },
  {
    pattern:
      /\b(password|passwd|api[_-]?key|secret|token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replace: (_match, key: string, separator: string) =>
      `${key}${separator}${REDACTED}`,
  },
];

export function redactSensitiveText(text: string): RedactionResult {
  let value = text;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    value =
      typeof replace === 'string'
        ? value.replace(pattern, replace)
        : value.replace(pattern, replace);
  }
  return {
    value,
    redacted: value !== text,
  };
}

export function createRedactedOutputPreview(
  output: string,
  options: OutputPreviewOptions = {},
): RedactedOutputPreview {
  const headChars = options.headChars ?? 2000;
  const tailChars = options.tailChars ?? 2000;
  const truncated = output.length > headChars + tailChars;
  const rawPreview = truncated
    ? `${output.slice(0, headChars)}\n...[TRUNCATED OUTPUT]...\n${output.slice(-tailChars)}`
    : output;
  const redacted = redactSensitiveText(rawPreview);

  return {
    preview: redacted.value,
    sha256: createHash('sha256').update(output).digest('hex'),
    originalLength: output.length,
    truncated,
    redacted: redacted.redacted,
  };
}

/**
 * Sanitize hook name to remove potentially sensitive information.
 * Extracts the base command name without arguments or full paths.
 *
 * This function protects PII by removing:
 * - Full file paths that may contain usernames
 * - Command arguments that may contain credentials, API keys, tokens
 * - Environment variables with sensitive values
 *
 * Examples:
 * - "/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123" -> "check-secrets.sh"
 * - "python /home/user/script.py --token=xyz" -> "python"
 * - "node index.js" -> "node"
 * - "C:\\Windows\\System32\\cmd.exe /c secret.bat" -> "cmd.exe"
 * - "" or "   " -> "unknown-command"
 *
 * @param hookName Full command string.
 * @returns Sanitized command name.
 */
export function sanitizeHookName(hookName: string): string {
  // Handle empty or whitespace-only strings
  if (!hookName || !hookName.trim()) {
    return 'unknown-command';
  }

  // Split by spaces to get command parts
  const parts = hookName.trim().split(/\s+/);
  if (parts.length === 0) {
    return 'unknown-command';
  }

  // Get the first part (the command)
  const command = parts[0];
  if (!command) {
    return 'unknown-command';
  }

  // If it's a path, extract just the basename
  if (command.includes('/') || command.includes('\\')) {
    const pathParts = command.split(/[/\\]/);
    const basename = pathParts[pathParts.length - 1];
    return basename || 'unknown-command';
  }

  return command;
}
