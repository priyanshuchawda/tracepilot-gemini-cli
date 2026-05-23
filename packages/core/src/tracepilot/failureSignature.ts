/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { stableStringify } from '../policy/stable-stringify.js';
import { redactSensitiveText } from '../telemetry/sanitize.js';

export type TracePilotRootCauseTaxonomy =
  | 'typescript_incompatibility'
  | 'lint_failure'
  | 'test_assertion_failure'
  | 'build_failure'
  | 'dependency_graph_failure'
  | 'runtime_exception'
  | 'unknown';

export interface TracePilotFailureSignal {
  command?: string;
  exitCode?: number;
  outputPreview?: string;
  outputSha256?: string;
  diagnostics?: string[];
  stackFrames?: string[];
  files?: string[];
  dependencies?: Record<string, string>;
}

export interface TracePilotFailureSignature {
  id: string;
  taxonomy: TracePilotRootCauseTaxonomy;
  commandFamily: string;
  exitCode?: number;
  diagnostics: string[];
  stackFrames: string[];
  files: string[];
  dependencies: Record<string, string>;
  outputSha256?: string;
  canonical: Record<string, unknown>;
}

export function buildTracePilotFailureSignature(
  signal: TracePilotFailureSignal,
): TracePilotFailureSignature {
  const commandFamily = normalizeCommandFamily(signal.command);
  const diagnostics = normalizeStringList([
    ...(signal.diagnostics ?? []),
    ...extractDiagnostics(signal.outputPreview),
  ]);
  const stackFrames = normalizeStringList([
    ...(signal.stackFrames ?? []),
    ...extractStackFrames(signal.outputPreview),
  ]);
  const files = normalizeStringList([
    ...(signal.files ?? []),
    ...extractFileReferences(signal.outputPreview),
  ]);
  const dependencies = normalizeDependencies(signal.dependencies);
  const taxonomy = inferRootCauseTaxonomy({
    commandFamily,
    diagnostics,
    files,
    outputPreview: signal.outputPreview,
  });
  const canonical = {
    commandFamily,
    dependencies,
    diagnostics,
    exitCode: signal.exitCode,
    files,
    outputSha256: signal.outputSha256,
    stackFrames,
    taxonomy,
  };

  return {
    id: `tracepilot-failure-${sha256(stableStringify(canonical)).slice(0, 24)}`,
    taxonomy,
    commandFamily,
    exitCode: signal.exitCode,
    diagnostics,
    stackFrames,
    files,
    dependencies,
    outputSha256: signal.outputSha256,
    canonical,
  };
}

function normalizeCommandFamily(command: string | undefined): string {
  const normalized = normalizeText(command);
  if (!normalized) {
    return 'unknown';
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?typecheck\b/.test(normalized)) {
    return 'typecheck';
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b/.test(normalized)) {
    return 'lint';
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/.test(normalized)) {
    return 'build';
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(normalized)) {
    return 'test';
  }
  if (/\b(?:tsc|vue-tsc)\b/.test(normalized)) {
    return 'typecheck';
  }
  if (/\beslint\b/.test(normalized)) {
    return 'lint';
  }
  return normalized.split(' ').slice(0, 3).join(' ');
}

function inferRootCauseTaxonomy(input: {
  commandFamily: string;
  diagnostics: string[];
  files: string[];
  outputPreview?: string;
}): TracePilotRootCauseTaxonomy {
  const haystack = normalizeText(
    [
      input.commandFamily,
      ...input.diagnostics,
      ...input.files,
      input.outputPreview,
    ].join('\n'),
  );
  if (
    /\btypescript\b/.test(haystack) ||
    /\bts\d{4}\b/.test(haystack) ||
    /\btypescript-eslint\b/.test(haystack) ||
    /\bparser\b.*\btypescript\b/.test(haystack)
  ) {
    return 'typescript_incompatibility';
  }
  if (input.commandFamily === 'lint' || /\beslint\b/.test(haystack)) {
    return 'lint_failure';
  }
  if (
    input.commandFamily === 'test' ||
    /\b(assertionerror|expected|received|failing test)\b/.test(haystack)
  ) {
    return 'test_assertion_failure';
  }
  if (input.commandFamily === 'build') {
    return 'build_failure';
  }
  if (
    /\b(lockfile|peer dep|peer dependency|eresolve|dependency)\b/.test(haystack)
  ) {
    return 'dependency_graph_failure';
  }
  if (/\b(typeerror|referenceerror|syntaxerror)\b/.test(haystack)) {
    return 'runtime_exception';
  }
  return 'unknown';
}

function extractDiagnostics(outputPreview: string | undefined): string[] {
  const text = redactSensitiveText(outputPreview ?? '').value;
  const diagnostics = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const normalized = normalizeDiagnosticLine(line);
    if (
      normalized &&
      (/\b(?:error|failed|assertionerror|typeerror|referenceerror)\b/i.test(
        normalized,
      ) ||
        /\bts\d{4}\b/i.test(normalized))
    ) {
      diagnostics.add(normalized);
    }
  }
  return [...diagnostics].slice(0, 12);
}

function extractStackFrames(outputPreview: string | undefined): string[] {
  const text = redactSensitiveText(outputPreview ?? '').value;
  const frames = new Set<string>();
  for (const match of text.matchAll(/\bat\s+([^\r\n]+)/g)) {
    frames.add(normalizeDiagnosticLine(match[1] ?? ''));
  }
  return [...frames].filter(Boolean).slice(0, 12);
}

function extractFileReferences(outputPreview: string | undefined): string[] {
  const text = redactSensitiveText(outputPreview ?? '').value;
  const files = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|json|mjs|cjs|yaml|yml))(?::\d+)?/g,
  )) {
    files.add(normalizePath(match[1] ?? ''));
  }
  return [...files].filter(Boolean).slice(0, 20);
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map(normalizeDiagnosticLine).filter(Boolean))]
    .sort()
    .slice(0, 32);
}

function normalizeDependencies(
  dependencies: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies ?? {}).sort()) {
    normalized[name.toLowerCase()] = normalizeText(version);
  }
  return normalized;
}

function normalizeDiagnosticLine(value: string): string {
  return normalizeText(value)
    .replace(/\b[a-f0-9]{7,64}\b/g, '<hash>')
    .replace(/\b\d+:\d+\b/g, '<line:col>')
    .replace(/\bline\s+\d+\b/g, 'line <n>')
    .replace(/[A-Z]:\//gi, '')
    .replace(/\\/g, '/')
    .trim();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase().trim();
}

function normalizeText(value: string | undefined): string {
  return redactSensitiveText(value ?? '')
    .value.toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
