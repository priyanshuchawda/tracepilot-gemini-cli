/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z, type ZodError } from 'zod';
import { redactSensitiveText } from '../telemetry/sanitize.js';

export class TracePilotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TracePilotValidationError';
  }
}

export const unknownRecordSchema: z.ZodType<Record<string, unknown>> = z.record(
  z.unknown(),
);

export function parseTracePilotSchema<T>(
  label: string,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new TracePilotValidationError(
    `Invalid TracePilot ${label}: ${formatZodIssues(result.error)}`,
  );
}

export function assertNoSecretLikeValues(label: string, value: unknown): void {
  const secretPath = findSecretPath(value);
  if (secretPath) {
    throw new TracePilotValidationError(
      `Invalid TracePilot ${label}: secret-like value at ${secretPath}`,
    );
  }
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      const detail =
        issue.code === 'custom' && issue.message ? issue.message : issue.code;
      return `${path}: ${detail}`;
    })
    .join('; ');
}

function findSecretPath(value: unknown, path = '<root>'): string | undefined {
  if (typeof value === 'string') {
    return redactSensitiveText(value).redacted ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findSecretPath(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redactSensitiveText(key).value;
      const found = findSecretPath(entry, `${path}.${safeKey}`);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
