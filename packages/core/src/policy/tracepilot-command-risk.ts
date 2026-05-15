/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type TracePilotCommandRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'blocked'
  | 'unknown';

export interface TracePilotCommandRisk {
  level: TracePilotCommandRiskLevel;
  reason: string;
}

export function classifyTracePilotCommandRisk(
  command: string | undefined,
): TracePilotCommandRisk {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return { level: 'unknown', reason: 'empty command' };
  }

  if (isBlockedCommand(normalized)) {
    return {
      level: 'blocked',
      reason:
        'command may expose credentials or destructively delete protected paths',
    };
  }

  if (isHighRiskCommand(normalized)) {
    return {
      level: 'high',
      reason:
        'command mutates remote state, permissions, deployment, or broad filesystem state',
    };
  }

  if (isLowRiskCommand(normalized)) {
    return {
      level: 'low',
      reason: 'command is read-only or project verification',
    };
  }

  return {
    level: 'medium',
    reason:
      'command may mutate local project state or run project-defined scripts',
  };
}

function normalizeCommand(command: string | undefined): string {
  return (command ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBlockedCommand(command: string): boolean {
  return (
    /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\$home\b|\$env:userprofile\b|%userprofile%)/.test(
      command,
    ) ||
    /\b(?:cat|type|get-content)\s+(?:\.\/)?(?:[^;&|]*\/)?\.env(?:\s|$)/.test(
      command,
    ) ||
    /^(?:printenv|env|set)(?:\s|$)/.test(command) ||
    /\b(?:grep|rg|ag)\b.*\b(?:api[_-]?key|password|passwd|secret|token|bearer|database_url)\b/i.test(
      command,
    )
  );
}

function isHighRiskCommand(command: string): boolean {
  return (
    /\bgit\s+push\b/.test(command) ||
    /\b(?:deploy|release|publish)\b/.test(command) ||
    /\b(?:vercel|netlify|wrangler)\s+(?:deploy|publish)\b/.test(command) ||
    /\b(?:chmod|chown)\b/.test(command) ||
    /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/.test(command)
  );
}

function isLowRiskCommand(command: string): boolean {
  return (
    /^(?:pwd|ls|dir)(?:\s|$)/.test(command) ||
    /^(?:grep|rg|cat)(?:\s|$)/.test(command) ||
    /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:build|test|typecheck|lint))(?:\s|$)/.test(
      command,
    )
  );
}
