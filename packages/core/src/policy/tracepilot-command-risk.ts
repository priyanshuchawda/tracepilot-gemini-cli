/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseCommandDetails,
  REDIRECTION_NAMES,
  type ParsedCommandDetail,
} from '../utils/shell-utils.js';

export type TracePilotCommandRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'blocked'
  | 'unknown';

export type TracePilotCommandRiskReasonCode =
  | 'empty_command'
  | 'parse_error'
  | 'credential_exposure'
  | 'protected_recursive_delete'
  | 'remote_mutation'
  | 'deployment_mutation'
  | 'encoded_command'
  | 'permission_mutation'
  | 'local_recursive_delete'
  | 'read_only_or_verification'
  | 'local_mutation_or_script';

export interface TracePilotParsedCommand {
  commandName: string;
  text: string;
  args: string[];
  source: 'structured' | 'wrapper' | 'fallback';
}

export interface TracePilotCommandRisk {
  level: TracePilotCommandRiskLevel;
  reason: string;
  reasonCode: TracePilotCommandRiskReasonCode;
  parsedCommands?: TracePilotParsedCommand[];
}

interface CommandSegment {
  raw: string;
  tokens: string[];
  commandName: string;
  source: TracePilotParsedCommand['source'];
}

interface ParsedSegments {
  segments: CommandSegment[];
  parserFailed: boolean;
}

const RISK_ORDER: Record<TracePilotCommandRiskLevel, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  blocked: 4,
};

export function classifyTracePilotCommandRisk(
  command: string | undefined,
): TracePilotCommandRisk {
  if (!command?.trim()) {
    return risk('unknown', 'empty_command');
  }

  const parsed = parseCommandSegments(command);
  if (parsed.parserFailed) {
    const fallbackBlocked = parsed.segments
      .map(classifyCommandSegment)
      .find((result) => result.level === 'blocked');
    if (fallbackBlocked) {
      return withParsedCommands(fallbackBlocked, parsed.segments);
    }
    return withParsedCommands(risk('high', 'parse_error'), parsed.segments);
  }

  if (parsed.segments.length === 0) {
    return risk('unknown', 'empty_command');
  }

  const result = parsed.segments
    .map(classifyCommandSegment)
    .reduce((highest, current) =>
      RISK_ORDER[current.level] > RISK_ORDER[highest.level] ? current : highest,
    );
  return withParsedCommands(result, parsed.segments);
}

function classifyCommandSegment(
  segment: CommandSegment,
): TracePilotCommandRisk {
  const blockedReasonCode = getBlockedReasonCode(segment);
  if (blockedReasonCode) {
    return risk('blocked', blockedReasonCode);
  }

  const highReasonCode = getHighReasonCode(segment);
  if (highReasonCode) {
    return risk('high', highReasonCode);
  }

  if (isLowRiskSegment(segment)) {
    return risk('low', 'read_only_or_verification');
  }

  return risk('medium', 'local_mutation_or_script');
}

function risk(
  level: TracePilotCommandRiskLevel,
  reasonCode: TracePilotCommandRiskReasonCode,
): TracePilotCommandRisk {
  return {
    level,
    reasonCode,
    reason: REASON_MESSAGES[reasonCode],
  };
}

const REASON_MESSAGES: Record<TracePilotCommandRiskReasonCode, string> = {
  empty_command: 'empty command',
  parse_error: 'command structure could not be parsed safely',
  credential_exposure:
    'command may expose credentials or destructively delete protected paths',
  protected_recursive_delete:
    'command may expose credentials or destructively delete protected paths',
  remote_mutation:
    'command mutates remote state, permissions, deployment, or broad filesystem state',
  deployment_mutation:
    'command mutates remote state, permissions, deployment, or broad filesystem state',
  encoded_command:
    'command mutates remote state, permissions, deployment, or broad filesystem state',
  permission_mutation:
    'command mutates remote state, permissions, deployment, or broad filesystem state',
  local_recursive_delete:
    'command mutates remote state, permissions, deployment, or broad filesystem state',
  read_only_or_verification: 'command is read-only or project verification',
  local_mutation_or_script:
    'command may mutate local project state or run project-defined scripts',
};

function withParsedCommands(
  result: TracePilotCommandRisk,
  segments: CommandSegment[],
): TracePilotCommandRisk {
  return {
    ...result,
    parsedCommands: segments.map((segment) => ({
      commandName: segment.commandName,
      text: segment.raw,
      args: segment.tokens.slice(1),
      source: segment.source,
    })),
  };
}

function parseCommandSegments(command: string): ParsedSegments {
  let parsed: ReturnType<typeof parseCommandDetails> | null = null;
  try {
    parsed = parseCommandDetails(command);
  } catch {
    parsed = null;
  }

  const fallbackSegments = parseFallbackSegments(command);
  if (!parsed) {
    return { segments: expandSegments(fallbackSegments), parserFailed: false };
  }

  if (parsed.hasError) {
    return { segments: expandSegments(fallbackSegments), parserFailed: true };
  }

  const structuredSegments = parsed.details
    .filter((detail) => !REDIRECTION_NAMES.has(detail.name))
    .map((detail) => segmentFromParsedDetail(detail))
    .filter((segment) => segment.commandName.length > 0);

  return {
    segments: expandSegments(
      structuredSegments.length > 0 ? structuredSegments : fallbackSegments,
    ),
    parserFailed: false,
  };
}

function segmentFromParsedDetail(detail: ParsedCommandDetail): CommandSegment {
  const raw = detail.text.trim();
  const tokens = tokenizeStructuredDetail(detail);
  const commandIndex = firstCommandTokenIndex(tokens);
  const commandName =
    commandIndex >= 0 ? normalizeCommandName(tokens[commandIndex] ?? '') : '';
  const commandTokens = commandIndex >= 0 ? tokens.slice(commandIndex) : tokens;
  return {
    raw: normalizeText(raw),
    tokens: commandTokens,
    commandName,
    source: 'structured',
  };
}

function tokenizeStructuredDetail(detail: ParsedCommandDetail): string[] {
  const fallbackTokens = tokenize(detail.text)
    .map(normalizeToken)
    .filter(Boolean);
  const normalizedName = normalizeCommandName(detail.name);
  if (!detail.args || detail.args.length === 0) {
    return fallbackTokens;
  }
  return [normalizedName, ...detail.args.map(normalizeToken).filter(Boolean)];
}

function parseFallbackSegments(command: string): CommandSegment[] {
  return splitCompoundCommand(command)
    .map((segment) => tokenizeCommandSegment(segment, 'fallback'))
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

function tokenizeCommandSegment(
  rawSegment: string,
  source: TracePilotParsedCommand['source'],
): CommandSegment {
  const tokens = tokenize(rawSegment).map(normalizeToken).filter(Boolean);
  const commandIndex = firstCommandTokenIndex(tokens);
  const commandName =
    commandIndex >= 0 ? normalizeCommandName(tokens[commandIndex] ?? '') : '';
  return {
    raw: normalizeText(rawSegment),
    tokens: commandIndex >= 0 ? tokens.slice(commandIndex) : tokens,
    commandName,
    source,
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
    const token = tokens[index] ?? '';
    if (token === '&' || isEnvironmentAssignment(token)) {
      continue;
    }
    return index;
  }
  return -1;
}

function expandSegments(segments: CommandSegment[]): CommandSegment[] {
  const expanded: CommandSegment[] = [];
  const stack = [...segments];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const segment = stack.shift()!;
    const key = `${segment.commandName}\0${segment.raw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    expanded.push(segment);
    stack.unshift(...expandWrapperSegment(segment));
  }

  return expanded;
}

function expandWrapperSegment(segment: CommandSegment): CommandSegment[] {
  const nested = getNestedWrapperCommand(segment);
  if (!nested) {
    return [];
  }
  return parseFallbackSegments(nested).map((nestedSegment) => ({
    ...nestedSegment,
    source: 'wrapper',
  }));
}

function getNestedWrapperCommand(segment: CommandSegment): string | undefined {
  const { commandName, tokens } = segment;
  if (['sh', 'bash', 'zsh'].includes(commandName)) {
    return nestedAfterFlag(tokens, ['-c']);
  }
  if (['powershell', 'pwsh'].includes(commandName)) {
    if (tokens.some((token) => ['-encodedcommand', '-enc'].includes(token))) {
      return undefined;
    }
    return nestedAfterFlag(tokens, ['-command', '-c', '/c']);
  }
  if (commandName === 'cmd') {
    return nestedAfterFlag(tokens, ['/c', '/k']);
  }
  if (commandName === 'npm' && ['exec', 'x'].includes(tokens[1] ?? '')) {
    return stripLeadingOptionTokens(tokens.slice(2)).join(' ');
  }
  if (commandName === 'npx') {
    return stripLeadingOptionTokens(tokens.slice(1)).join(' ');
  }
  return undefined;
}

function nestedAfterFlag(
  tokens: string[],
  flags: string[],
): string | undefined {
  const index = tokens.findIndex(
    (token, tokenIndex) => tokenIndex > 0 && flags.includes(token),
  );
  if (index < 0 || index === tokens.length - 1) {
    return undefined;
  }
  return unwrapOuterQuotes(tokens.slice(index + 1).join(' '));
}

function stripLeadingOptionTokens(tokens: string[]): string[] {
  let index = 0;
  const booleanOptions = new Set([
    '-y',
    '--yes',
    '--no-install',
    '--ignore-existing',
  ]);
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      index++;
      break;
    }
    if (!token.startsWith('-')) {
      break;
    }
    index++;
    if (token.includes('=') || booleanOptions.has(token)) {
      continue;
    }
    const next = tokens[index] ?? '';
    if (next && !next.startsWith('-')) {
      index++;
    }
  }
  return tokens.slice(index);
}

function getBlockedReasonCode(
  segment: CommandSegment,
): TracePilotCommandRiskReasonCode | undefined {
  const { raw, tokens, commandName } = segment;
  if (isProtectedRecursiveDelete(segment)) {
    return 'protected_recursive_delete';
  }
  if (hasSensitiveRedirection(tokens) || hasSensitiveRedirectionText(raw)) {
    return 'credential_exposure';
  }
  if (isReadFileCommand(commandName) && tokens.some(isDotEnvPath)) {
    return 'credential_exposure';
  }
  if (isEnvironmentDump(segment)) {
    return 'credential_exposure';
  }
  if (isSecretSearchCommand(commandName) && containsSecretKeyword(raw)) {
    return 'credential_exposure';
  }
  if (containsCredentialReference(raw)) {
    return 'credential_exposure';
  }
  return undefined;
}

function getHighReasonCode(
  segment: CommandSegment,
): TracePilotCommandRiskReasonCode | undefined {
  const { raw, tokens, commandName } = segment;
  if (['powershell', 'pwsh'].includes(commandName)) {
    if (tokens.some((token) => ['-encodedcommand', '-enc'].includes(token))) {
      return 'encoded_command';
    }
  }
  if (commandName === 'git' && tokens[1] === 'push') {
    return 'remote_mutation';
  }
  if (
    (['vercel', 'netlify', 'wrangler'].includes(commandName) &&
      ['deploy', 'publish'].some((verb) => tokens.includes(verb))) ||
    /\b(?:deploy|release|publish)\b/.test(raw)
  ) {
    return 'deployment_mutation';
  }
  if (['chmod', 'chown', 'icacls', 'takeown'].includes(commandName)) {
    return 'permission_mutation';
  }
  if (isRecursiveDelete(segment)) {
    return 'local_recursive_delete';
  }
  return undefined;
}

function isLowRiskSegment(segment: CommandSegment): boolean {
  const { tokens, commandName } = segment;
  return (
    ['pwd', 'ls', 'dir', 'get-childitem', 'gci'].includes(commandName) ||
    ['vitest', 'jest', 'tsc', 'eslint'].includes(commandName) ||
    isReadFileCommand(commandName) ||
    isSecretSearchCommand(commandName) ||
    isNpmVerification(tokens)
  );
}

function unwrapOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
  return basename.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
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

function containsCredentialReference(value: string): boolean {
  return (
    /\bprocess\.env\b/i.test(value) ||
    /\$env:[a-z0-9_]*(?:api[_-]?key|token|secret|password|credential)[a-z0-9_]*/i.test(
      value,
    ) ||
    /%[a-z0-9_]*(?:api[_-]?key|token|secret|password|credential)[a-z0-9_]*%/i.test(
      value,
    ) ||
    /\$[a-z0-9_]*(?:api[_-]?key|token|secret|password|credential)[a-z0-9_]*/i.test(
      value,
    )
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

function hasSensitiveRedirection(tokens: string[]): boolean {
  return tokens.some(
    (token, index) =>
      isRedirectionToken(token) &&
      tokens.slice(index + 1).some((candidate) => isDotEnvPath(candidate)),
  );
}

function hasSensitiveRedirectionText(value: string): boolean {
  return />{1,2}\s*['"`]?(?:\.\/)?\.env(?:$|[.\w-])/i.test(value);
}

function isRedirectionToken(token: string): boolean {
  return (
    /^(\d*)?>{1,2}$/.test(token) || token === 'out-file' || token === 'tee'
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
  if (['npm', 'pnpm', 'yarn'].includes(commandName ?? '')) {
    if (firstArg === 'test') {
      return true;
    }
    return (
      firstArg === 'run' &&
      ['build', 'test', 'typecheck', 'lint'].includes(secondArg ?? '')
    );
  }
  if (commandName === 'npx') {
    const command = stripLeadingOptionTokens(tokens.slice(1))[0];
    return ['vitest', 'jest', 'tsc', 'eslint'].includes(command ?? '');
  }
  return false;
}
