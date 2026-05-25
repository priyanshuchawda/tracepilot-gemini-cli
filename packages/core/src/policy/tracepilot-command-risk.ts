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
  const segments = parseCommandSegments(command);
  if (segments.length === 0) {
    return { level: 'unknown', reason: 'empty command' };
  }

  return segments
    .map(classifyCommandSegment)
    .reduce((highest, current) =>
      RISK_ORDER[current.level] > RISK_ORDER[highest.level] ? current : highest,
    );
}

const RISK_ORDER: Record<TracePilotCommandRiskLevel, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  blocked: 4,
};

interface CommandSegment {
  raw: string;
  tokens: string[];
  commandName: string;
}

function classifyCommandSegment(
  segment: CommandSegment,
): TracePilotCommandRisk {
  if (isBlockedSegment(segment)) {
    return {
      level: 'blocked',
      reason:
        'command may expose credentials or destructively delete protected paths',
    };
  }

  if (isHighRiskSegment(segment)) {
    return {
      level: 'high',
      reason:
        'command mutates remote state, permissions, deployment, or broad filesystem state',
    };
  }

  if (isLowRiskSegment(segment)) {
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

function isBlockedSegment(segment: CommandSegment): boolean {
  const { raw, tokens, commandName } = segment;
  return (
    isProtectedRecursiveDelete(segment) ||
    (isReadFileCommand(commandName) && tokens.some(isDotEnvPath)) ||
    isEnvironmentDump(segment) ||
    (isSecretSearchCommand(commandName) && containsSecretKeyword(raw))
  );
}

function isHighRiskSegment(segment: CommandSegment): boolean {
  const { raw, tokens, commandName } = segment;
  return (
    (commandName === 'git' && tokens[1] === 'push') ||
    /\b(?:deploy|release|publish)\b/.test(raw) ||
    (['powershell', 'pwsh'].includes(commandName) &&
      tokens.includes('-encodedcommand')) ||
    (['vercel', 'netlify', 'wrangler'].includes(commandName) &&
      ['deploy', 'publish'].some((verb) => tokens.includes(verb))) ||
    ['chmod', 'chown', 'icacls', 'takeown'].includes(commandName) ||
    isRecursiveDelete(segment)
  );
}

function isLowRiskSegment(segment: CommandSegment): boolean {
  const { tokens, commandName } = segment;
  return (
    ['pwd', 'ls', 'dir', 'get-childitem', 'gci'].includes(commandName) ||
    isReadFileCommand(commandName) ||
    isSecretSearchCommand(commandName) ||
    isNpmVerification(tokens)
  );
}

function parseCommandSegments(command: string | undefined): CommandSegment[] {
  return splitCompoundCommand(command ?? '')
    .map(tokenizeCommandSegment)
    .flatMap(expandShellWrapper)
    .filter((segment) => segment.commandName.length > 0);
}

function splitCompoundCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === '\n' ||
      char === ';' ||
      (char === '|' && next === '|') ||
      (char === '&' && next === '&') ||
      char === '|' ||
      char === '&'
    ) {
      if (current.trim()) {
        segments.push(current);
      }
      current = '';
      if ((char === '|' && next === '|') || (char === '&' && next === '&')) {
        index++;
      }
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    segments.push(current);
  }
  return segments;
}

function tokenizeCommandSegment(rawSegment: string): CommandSegment {
  const tokens = tokenize(rawSegment).map(normalizeToken).filter(Boolean);
  const commandIndex = firstCommandTokenIndex(tokens);
  const commandName =
    commandIndex >= 0 ? normalizeCommandName(tokens[commandIndex]) : '';
  return {
    raw: normalizeText(rawSegment),
    tokens: commandIndex >= 0 ? tokens.slice(commandIndex) : tokens,
    commandName,
  };
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (const char of value) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function firstCommandTokenIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '&' || isEnvironmentAssignment(token)) {
      continue;
    }
    return index;
  }
  return -1;
}

function expandShellWrapper(segment: CommandSegment): CommandSegment[] {
  if (!['powershell', 'pwsh', 'cmd'].includes(segment.commandName)) {
    return [segment];
  }
  const commandFlagIndex = segment.tokens.findIndex((token, index) => {
    if (segment.commandName === 'cmd') {
      return index > 0 && ['/c', '/k'].includes(token);
    }
    return (
      index > 0 && ['-command', '-c', '/c', '-encodedcommand'].includes(token)
    );
  });
  if (commandFlagIndex < 0 || commandFlagIndex === segment.tokens.length - 1) {
    return [segment];
  }
  if (segment.tokens[commandFlagIndex] === '-encodedcommand') {
    return [segment];
  }
  const nested = segment.tokens.slice(commandFlagIndex + 1).join(' ');
  return parseCommandSegments(nested);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .replace(/^[([{]+|[)\]}]+$/g, '')
    .toLowerCase();
}

function normalizeCommandName(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? value;
  return basename.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[a-z_][a-z0-9_]*=.*/i.test(token);
}

function isDotEnvPath(token: string): boolean {
  return /(?:^|[/\\])\.env(?:$|[.\w-]*$)/.test(stripPathPunctuation(token));
}

function stripPathPunctuation(value: string): string {
  return value.replace(/^['"`]+|['"`),;]+$/g, '');
}

function isReadFileCommand(commandName: string): boolean {
  return ['cat', 'type', 'get-content', 'gc'].includes(commandName);
}

function isSecretSearchCommand(commandName: string): boolean {
  return ['grep', 'rg', 'ag', 'findstr', 'select-string', 'sls'].includes(
    commandName,
  );
}

function containsSecretKeyword(value: string): boolean {
  return /\b(?:api[_-]?key|password|passwd|secret|token|bearer|database_url|private[_-]?key)\b/i.test(
    value,
  );
}

function isEnvironmentDump(segment: CommandSegment): boolean {
  const { tokens, commandName } = segment;
  return (
    commandName === 'printenv' ||
    (commandName === 'env' && tokens.length === 1) ||
    (commandName === 'set' && tokens.length === 1) ||
    (['get-childitem', 'gci', 'dir', 'ls'].includes(commandName) &&
      tokens.some((token) => token.replace(/\\$/, '') === 'env:'))
  );
}

function isProtectedRecursiveDelete(segment: CommandSegment): boolean {
  return isRecursiveDelete(segment) && segment.tokens.some(isProtectedPath);
}

function isRecursiveDelete(segment: CommandSegment): boolean {
  const { tokens, commandName } = segment;
  if (['rm', 'rmdir', 'rd'].includes(commandName)) {
    return tokens.some((token) => /^-[a-z]*r[a-z]*f?[a-z]*$/.test(token));
  }
  if (['del', 'erase'].includes(commandName)) {
    return tokens.some((token) => token === '/s') && tokens.includes('/q');
  }
  if (['remove-item', 'ri'].includes(commandName)) {
    return tokens.some((token) => ['-recurse', '-r'].includes(token));
  }
  return false;
}

function isProtectedPath(token: string): boolean {
  const path = stripPathPunctuation(token).replace(/\\/g, '/').toLowerCase();
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return (
    normalized === '/' ||
    normalized === '~' ||
    normalized === '$home' ||
    normalized === '$env:userprofile' ||
    normalized === '%userprofile%' ||
    /^[a-z]:$/i.test(normalized) ||
    /^[a-z]:\/$/i.test(normalized) ||
    /^[a-z]:\/users$/i.test(normalized)
  );
}

function isNpmVerification(tokens: string[]): boolean {
  const [commandName, firstArg, secondArg] = tokens;
  if (!['npm', 'pnpm', 'yarn'].includes(commandName ?? '')) {
    return false;
  }
  if (firstArg === 'test') {
    return true;
  }
  return (
    firstArg === 'run' &&
    ['build', 'test', 'typecheck', 'lint'].includes(secondArg ?? '')
  );
}
