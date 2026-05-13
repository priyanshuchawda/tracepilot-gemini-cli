/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const SERVICE_NAME = 'gemini-cli';
export const SERVICE_DESCRIPTION =
  'Gemini CLI is an open-source AI agent that brings the power of Gemini directly into your terminal. It is designed to be a terminal-first, extensible, and powerful tool for developers, engineers, SREs, and beyond.';

// Gemini CLI specific semantic conventions
// https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/#genai-attributes
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const GEN_AI_AGENT_DESCRIPTION = 'gen_ai.agent.description';
export const GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
export const GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GEN_AI_PROMPT_NAME = 'gen_ai.prompt.name';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call_id';
export const GEN_AI_TOOL_DESCRIPTION = 'gen_ai.tool.description';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
export const GEN_AI_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';
export const GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';

// OpenInference semantic convention used by Phoenix to render span kinds.
export const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind';

export const GEMINI_CLI_OPERATION_KIND = 'gemini_cli.operation.kind';
export const GEMINI_CLI_TURN_ID = 'gemini_cli.turn.id';
export const GEMINI_CLI_TOOL_KIND = 'gemini_cli.tool.kind';
export const GEMINI_CLI_COMMAND_RISK_LEVEL = 'gemini_cli.command.risk_level';
export const GEMINI_CLI_COMMAND_EXIT_CODE = 'gemini_cli.command.exit_code';
export const GEMINI_CLI_DURATION_MS = 'gemini_cli.duration_ms';
export const GEMINI_CLI_OUTPUT_PREVIEW = 'gemini_cli.output.preview';
export const GEMINI_CLI_OUTPUT_SHA256 = 'gemini_cli.output.sha256';
export const GEMINI_CLI_OUTPUT_ORIGINAL_LENGTH =
  'gemini_cli.output.original_length';
export const GEMINI_CLI_OUTPUT_TRUNCATED = 'gemini_cli.output.truncated';
export const GEMINI_CLI_OUTPUT_REDACTED = 'gemini_cli.output.redacted';
export const GEMINI_CLI_FILE_PATH = 'gemini_cli.file.path';
export const GEMINI_CLI_MCP_SERVER = 'gemini_cli.mcp.server';
export const GEMINI_CLI_MCP_TOOL = 'gemini_cli.mcp.tool';

export enum OpenInferenceSpanKind {
  Agent = 'AGENT',
  Chain = 'CHAIN',
  Llm = 'LLM',
  Tool = 'TOOL',
}

// Gemini CLI specific operations
export enum GeminiCliOperation {
  ToolCall = 'tool_call',
  ToolShell = 'gemini_cli.tool.shell',
  ToolFile = 'gemini_cli.tool.file',
  ToolMcp = 'gemini_cli.tool.mcp',
  ToolPhoenixMcp = 'gemini_cli.tool.phoenix_mcp',
  LLMCall = 'llm_call',
  LLMGenerate = 'gemini_cli.llm.generate',
  UserPrompt = 'user_prompt',
  SystemPrompt = 'system_prompt',
  AgentCall = 'agent_call',
  AgentTurn = 'gemini_cli.agent_turn',
  ScheduleToolCalls = 'schedule_tool_calls',
  SelfIntrospection = 'gemini_cli.chain.self_introspection',
}
