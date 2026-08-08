import { ndJsonStream, PROTOCOL_VERSION, methods, client } from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type ToolCall, type Usage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";

import type { ExtensionConfig } from "./config.js";
import { redactSensitiveString } from "./debug-logger.js";
import type { DebugLogger } from "./debug-logger.js";
import { ByteQueue, parseEventFrame, type JsonRecord } from "./eventstream.js";
import { omitAuthorizationHeaders } from "./headers.js";
import { isRecord, optionalString, KIRO_PROFILE_ARN_HEADER, readJsonResponse } from "./shared/index.js";

interface KiroRuntimeState {
  cwd?: string;
}

interface KiroToolSpecification {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: unknown };
  };
}

interface KiroToolResult {
  toolUseId: string;
  status: "success" | "error";
  content: Array<{ text: string } | { json: unknown }>;
}

interface KiroUserInputMessageContext {
  tools?: KiroToolSpecification[];
  toolResults?: KiroToolResult[];
}

interface KiroUserInputMessage {
  userInputMessage: {
    content: string;
    modelId: string;
    origin?: "AI_EDITOR" | "KIRO_CLI";
    userInputMessageContext?: KiroUserInputMessageContext;
  };
}

interface KiroAssistantResponseMessage {
  assistantResponseMessage: {
    messageId?: string;
    content: string;
    toolUses?: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>;
  };
}

type KiroConversationMessage = KiroUserInputMessage | KiroAssistantResponseMessage;

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: KiroUserInputMessage;
    history: KiroConversationMessage[];
    agentContinuationId?: string;
    agentTaskType?: "vibe" | string;
  };
  profileArn?: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    };
}

interface KiroStreamState {
  textContentIndex?: number;
  thinkingContentIndex?: number;
  hasText: boolean;
  hasToolCalls: boolean;
  toolCallsById: Map<string, KiroStreamingToolCall>;
  totalContentLength: number;
  contextUsagePercentage: number;
  usage?: Usage;
}

interface KiroStreamingToolCall {
  contentIndex: number;
  toolCall: ToolCall;
  inputBuffer: string;
  ended: boolean;
}

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const API_MAX_OUTPUT_TOKENS = 200_000;
const KIRO_NAMESPACE = "34f7193f-561d-4050-bc84-9547d953d6bf";
const KIRO_STREAMING_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const KIRO_CODEWHISPERER_SDK_USER_AGENT = "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0";
const KIRO_CODEWHISPERER_AMZ_USER_AGENT = "aws-sdk-js/3.0.0 kiro-ide/1.0.0";
const KIRO_Q_SDK_USER_AGENT = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.14474 os/windows lang/rust/1.92.0 md/appVersion-2.3.0 app/AmazonQ-For-CLI";
const KIRO_Q_AMZ_USER_AGENT = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.14474 os/windows lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";
const KIRO_CLI_CONTEXT_BLOCK_PATTERN = /--- CONTEXT ENTRY BEGIN ---[\s\S]*?--- CONTEXT ENTRY END ---\s*/g;
const KIRO_CLI_USER_MESSAGE_PATTERN = /--- USER MESSAGE BEGIN ---([\s\S]*?)--- USER MESSAGE END ---/g;

export type KiroCredentialMode = "managed" | "env-token" | "static-config";

export interface KiroAuthFailureMetadata {
  providerId: string;
  status: number;
  reason: "unauthorized" | "auth_expired" | "auth_rejected" | "quota_or_entitlement" | "forbidden" | "missing_token" | "http_error";
  refreshable: boolean;
  credentialMode: KiroCredentialMode;
  retryAfterMs?: number;
}

export class KiroAuthFailureError extends Error {
  readonly kiroAuth: KiroAuthFailureMetadata;

  constructor(message: string, metadata: KiroAuthFailureMetadata, options?: { cause?: unknown }) {
    super(redactSensitiveString(message), options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KiroAuthFailureError";
    this.kiroAuth = { ...metadata };
  }
}

interface ResolvedKiroCredential {
  apiKey: string;
  mode: KiroCredentialMode;
}

function isKiroCliDefaultAgentInstruction(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("Follow this instruction: # Kiro CLI Default Agent") && normalized.includes("## Key Capabilities") && normalized.includes("### Code Intelligence");
}

function isKiroCliInstructionAck(text: string): boolean {
  return text.trim() === "I will fully incorporate this information when generating my responses, and explicitly acknowledge relevant parts of the summary when answering questions.";
}

function pruneKiroCliPromptScaffolding(text: string): string {
  const userMessages = [...text.matchAll(KIRO_CLI_USER_MESSAGE_PATTERN)].map((match) => match[1]?.trim()).filter((entry): entry is string => Boolean(entry));
  if (userMessages.length > 0) return userMessages.join("\n\n").trim();
  const withoutContextEntries = text.replace(KIRO_CLI_CONTEXT_BLOCK_PATTERN, "").trim();
  if (isKiroCliDefaultAgentInstruction(withoutContextEntries)) return "";
  return withoutContextEntries;
}

function textFromContent(content: string | (TextContent | ImageContent)[], options?: { pruneKiroCliScaffolding?: boolean }): string {
  const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "[image omitted]")).join("");
  return options?.pruneKiroCliScaffolding ? pruneKiroCliPromptScaffolding(text) : text;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolSchemaForRequest(tool: Tool): unknown {
  return tool.parameters ?? { type: "object", properties: {} };
}

function descriptionIncludesAll(description: string, terms: string[]): boolean {
  return terms.every((term) => description.includes(term));
}

function isKiroCliInjectedTool(tool: Tool): boolean {
  const description = tool.description.toLowerCase();
  if (tool.name === "code") return descriptionIncludesAll(description, ["code intelligence", "ast"]);
  if (tool.name === "dummy") return descriptionIncludesAll(description, ["dummy tool", "list of available tools"]);
  if (tool.name === "execute_cmd") return description.includes("windows command");
  if (tool.name === "fs_read") return descriptionIncludesAll(description, ["available modes", "line", "directory"]);
  if (tool.name === "fs_write") return description.includes("str_replace") || description.includes("file_text");
  if (tool.name === "glob") return descriptionIncludesAll(description, ["totalfiles", "filepath"]);
  if (tool.name === "grep") return descriptionIncludesAll(description, ["semantic code understanding", "rg", "ag"]);
  if (tool.name === "introspect") return descriptionIncludesAll(description, ["chat application's own features", "slash commands"]);
  if (tool.name === "report_issue") return descriptionIncludesAll(description, ["pre-filled", "conversation transcript", "chat request ids"]);
  if (tool.name === "session") return descriptionIncludesAll(description, ["adjust session settings", "introspect tool first"]);
  if (tool.name === "use_aws") return descriptionIncludesAll(description, ["aws cli", "service", "operation"]);
  if (tool.name === "use_subagent") return description.includes("critical delegation tool");
  if (tool.name === "web_fetch") return descriptionIncludesAll(description, ["selective", "truncated", "full"]);
  if (tool.name === "web_search") return descriptionIncludesAll(description, ["websearch", "outside the model's training data"]);
  if (tool.name === "shell") return description.includes("command");
  return false;
}

function buildKiroTools(tools: Tool[] | undefined): KiroToolSpecification[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const filteredTools = tools.filter((tool) => !isKiroCliInjectedTool(tool));
  if (filteredTools.length === 0) return undefined;
  return filteredTools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description.trim() || `Tool: ${tool.name}`,
      inputSchema: { json: toolSchemaForRequest(tool) },
    },
  }));
}

function assistantText(message: Extract<Context["messages"][number], { role: "assistant" }>): string {
  return message.content
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => (part.type === "text" ? part.text : part.thinking))
    .join("\n")
    .trim();
}

function assistantToolUses(message: Extract<Context["messages"][number], { role: "assistant" }>): Array<{ toolUseId: string; name: string; input: Record<string, unknown> }> | undefined {
  const toolUses = message.content
    .filter((part): part is ToolCall => part.type === "toolCall")
    .map((part) => ({ toolUseId: part.id, name: part.name, input: parseToolInput(part.arguments) }));
  return toolUses.length > 0 ? toolUses : undefined;
}

function toolResultFromMessage(message: Extract<Context["messages"][number], { role: "toolResult" }>): KiroToolResult {
  return {
    toolUseId: message.toolCallId,
    status: message.isError ? "error" : "success",
    content: [{ text: textFromContent(message.content) }],
  };
}

function makeUserMessage(content: string, modelId: string, context?: KiroUserInputMessageContext, current = false): KiroUserInputMessage {
  const trimmedContent = content.trim();
  const hasToolResults = Boolean(context?.toolResults?.length);
  const userInputMessage: KiroUserInputMessage["userInputMessage"] = {
    content: trimmedContent || (hasToolResults ? "" : "continue"),
    modelId,
  };
  if (current) userInputMessage.origin = "AI_EDITOR";
  if (context && (context.tools?.length || context.toolResults?.length)) userInputMessage.userInputMessageContext = context;
  return { userInputMessage };
}

function convertMessages(context: Context, modelId: string): { history: KiroConversationMessage[]; currentMessage: KiroUserInputMessage } {
  const history: KiroConversationMessage[] = [];
  const tools = buildKiroTools(context.tools);
  let pendingUserContent: string[] = [];
  let pendingToolResults: KiroToolResult[] = [];
  let currentRole: "user" | "assistant" | null = null;
  let currentMessage: KiroUserInputMessage | null = null;
  let skippedKiroCliInstruction = false;

  const flushUser = (): void => {
    const userContext: KiroUserInputMessageContext = {};
    if (pendingToolResults.length > 0) userContext.toolResults = pendingToolResults;
    const message = makeUserMessage(pendingUserContent.join("\n\n"), modelId, userContext);
    history.push(message);
    currentMessage = message;
    pendingUserContent = [];
    pendingToolResults = [];
  };

  const flushRole = (): void => {
    if (currentRole === "user") flushUser();
    currentRole = null;
  };

  for (const message of context.messages) {
    if (message.role === "user") {
      const userContent = textFromContent(message.content, { pruneKiroCliScaffolding: true });
      if (!userContent) {
        skippedKiroCliInstruction = true;
        continue;
      }
      if (currentRole !== "user") flushRole();
      currentRole = "user";
      pendingUserContent.push(userContent);
      skippedKiroCliInstruction = false;
      continue;
    }

    if (message.role === "toolResult") {
      if (currentRole !== "user") flushRole();
      currentRole = "user";
      pendingToolResults.push(toolResultFromMessage(message));
      continue;
    }

    if (message.role === "assistant") {
      const toolUses = assistantToolUses(message);
      const assistantContent = assistantText(message);
      if (skippedKiroCliInstruction && !toolUses && isKiroCliInstructionAck(assistantContent)) {
        skippedKiroCliInstruction = false;
        continue;
      }
      skippedKiroCliInstruction = false;
      flushRole();
      const content = toolUses ? "" : assistantContent || "...";
      history.push({
        assistantResponseMessage: {
          content,
          ...(toolUses ? { messageId: message.responseId ?? uuidFromHash(`${message.model}:${message.timestamp}:${toolUses.map((toolUse) => toolUse.toolUseId).join(",")}`), toolUses } : {}),
        },
      });
    }
  }

  flushRole();

  if (history.length > 0 && "userInputMessage" in history[history.length - 1]) {
    currentMessage = history.pop() as KiroUserInputMessage;
  }

  if (!currentMessage) {
    currentMessage = makeUserMessage("Continue", modelId);
  }

  const currentContext = currentMessage.userInputMessage.userInputMessageContext ?? {};
  if (tools && tools.length > 0) currentContext.tools = tools;
  if (Object.keys(currentContext).length > 0) currentMessage.userInputMessage.userInputMessageContext = currentContext;
  currentMessage.userInputMessage.origin = "AI_EDITOR";
  currentMessage.userInputMessage.modelId = modelId;

  for (const item of history) {
    if ("userInputMessage" in item) {
      item.userInputMessage.modelId = modelId;
      delete item.userInputMessage.origin;
      if (item.userInputMessage.userInputMessageContext?.tools) delete item.userInputMessage.userInputMessageContext.tools;
      if (item.userInputMessage.userInputMessageContext && Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
        delete item.userInputMessage.userInputMessageContext;
      }
    }
  }

  return { history, currentMessage };
}

function uuidFromHash(value: string): string {
  const bytes = createHash("sha1").update(`${KIRO_NAMESPACE}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildSystemPrefix(context: Context): string {
  const systemPrompt = context.systemPrompt?.join("\n\n").trim() ?? "";
  if (!systemPrompt || isKiroCliDefaultAgentInstruction(systemPrompt)) return "";
  return `<Pi system instructions>\n${systemPrompt}\n</Pi system instructions>`;
}

function firstUserConversationContent(history: KiroConversationMessage[], currentMessage: KiroUserInputMessage): string {
  const firstUserHistoryItem = history.find((item): item is KiroUserInputMessage => "userInputMessage" in item);
  return firstUserHistoryItem?.userInputMessage.content || currentMessage.userInputMessage.content;
}

function prependSystemInstructionHistory(history: KiroConversationMessage[], systemPrefix: string, modelId: string): void {
  if (!systemPrefix) return;
  history.unshift(
    makeUserMessage(systemPrefix, modelId),
    {
      assistantResponseMessage: {
        content: "Understood. I will follow the Pi system instructions.",
      },
    },
  );
}

function isAmazonQEndpoint(config: ExtensionConfig): boolean {
  if (config.endpoint === "amazonq") return true;
  try {
    return new URL(config.upstreamUrl).hostname.toLowerCase() === "q.us-east-1.amazonaws.com";
  } catch {
    return false;
  }
}

function setUserMessageOrigin(history: KiroConversationMessage[], currentMessage: KiroUserInputMessage, origin: "AI_EDITOR" | "KIRO_CLI"): void {
  currentMessage.userInputMessage.origin = origin;
  for (const item of history) {
    if ("userInputMessage" in item) item.userInputMessage.origin = origin;
  }
}

function resolveMaxTokens(model: Model<Api>, options?: SimpleStreamOptions): number {
  const requested = options?.maxTokens ?? Math.min(model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  return Math.max(1, Math.min(requested, API_MAX_OUTPUT_TOKENS));
}

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const normalizedName = name.toLowerCase();
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      const value = headers[headerName];
      return value || undefined;
    }
  }
  return undefined;
}

function omitInternalKiroHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(headers).filter(
      ([headerName]) => headerName.toLowerCase() !== KIRO_PROFILE_ARN_HEADER,
    ),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function buildRequest(model: Model<Api>, context: Context, config: ExtensionConfig, options?: SimpleStreamOptions): KiroRequest {
  const { history, currentMessage } = convertMessages(context, model.id);
  const firstContent = firstUserConversationContent(history, currentMessage);
  prependSystemInstructionHistory(history, buildSystemPrefix(context), model.id);
  const amazonQEndpoint = isAmazonQEndpoint(config);
  if (amazonQEndpoint) setUserMessageOrigin(history, currentMessage, "KIRO_CLI");
  const profileArn = getHeaderCaseInsensitive(options?.headers, KIRO_PROFILE_ARN_HEADER) ?? config.profileArn;
  const conversationState: KiroRequest["conversationState"] = {
    chatTriggerType: "MANUAL",
    conversationId: uuidFromHash((firstContent || currentMessage.userInputMessage.content).slice(0, 4_000)) || randomUUID(),
    currentMessage,
    history,
  };
  if (amazonQEndpoint) {
    conversationState.agentContinuationId = randomUUID();
    conversationState.agentTaskType = "vibe";
  }
  const request: KiroRequest = { conversationState };
  if (profileArn) request.profileArn = profileArn;

  const maxTokens = resolveMaxTokens(model, options);
  if (!amazonQEndpoint && (maxTokens || options?.temperature !== undefined)) {
    request.inferenceConfig = { maxTokens };
    if (options?.temperature !== undefined) request.inferenceConfig.temperature = options.temperature;
  }
  return request;
}

function missingTokenError(envVarName: string, providerId: string): KiroAuthFailureError {
  return new KiroAuthFailureError(
    `No Kiro access token configured. Static environment token mode (${envVarName}) is unmanaged and non-rotating; set ${envVarName}, run /login ${providerId}, or enable pi-multi-auth credentials for ${providerId}.`,
    {
      providerId,
      status: 0,
      reason: "missing_token",
      refreshable: false,
      credentialMode: "env-token",
    },
  );
}

function resolveKiroCredential(config: ExtensionConfig, options?: SimpleStreamOptions): ResolvedKiroCredential {
  const optionKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
  if (optionKey && optionKey !== config.apiKey) return { apiKey: optionKey, mode: "managed" };
  if (ENV_VAR_PATTERN.test(config.apiKey)) {
    const envKey = process.env[config.apiKey];
    if (envKey) return { apiKey: envKey, mode: "env-token" };
    if (optionKey) return { apiKey: optionKey, mode: "managed" };
    throw missingTokenError(config.apiKey, config.providerId);
  }
  if (optionKey) return { apiKey: optionKey, mode: "managed" };
  return { apiKey: config.apiKey, mode: "static-config" };
}

export function buildHeaders(config: ExtensionConfig, apiKey: string, options?: SimpleStreamOptions): Record<string, string> {
  const amazonQEndpoint = isAmazonQEndpoint(config);
  const headers: Record<string, string> = amazonQEndpoint ? {
    "Content-Type": "application/x-amz-json-1.0",
    Accept: "*/*",
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "User-Agent": KIRO_Q_SDK_USER_AGENT,
    "X-Amz-User-Agent": KIRO_Q_AMZ_USER_AGENT,
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": randomUUID(),
    "x-amzn-codewhisperer-optout": "false",
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(config.headers)),
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(options?.headers)),
  } : {
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "User-Agent": KIRO_CODEWHISPERER_SDK_USER_AGENT,
    "X-Amz-User-Agent": KIRO_CODEWHISPERER_AMZ_USER_AGENT,
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": randomUUID(),
    "x-amzn-bedrock-cache-control": "enable",
    "anthropic-beta": "prompt-caching-2024-07-31",
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(config.headers)),
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(options?.headers)),
  };
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function createRequestSignal(options: SimpleStreamOptions | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  const timeout = setTimeout(() => {
    if (!disposed) controller.abort(new Error(`Kiro request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  const abortFromParent = (): void => {
    if (!disposed) controller.abort(options?.signal?.reason ?? new Error("Kiro request aborted."));
  };
  if (options?.signal?.aborted) abortFromParent();
  options?.signal?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      disposed = true;
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function extractErrorMessage(payload: JsonRecord, status: number): string {
  if (typeof payload.message === "string" && payload.message.trim()) return redactSensitiveString(payload.message.trim());
  if (typeof payload.error === "string" && payload.error.trim()) return redactSensitiveString(payload.error.trim());
  if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) return redactSensitiveString(payload.error.message.trim());
  return `Kiro request failed with HTTP ${status}.`;
}

function payloadSearchText(payload: JsonRecord): string {
  try {
    return JSON.stringify(payload).toLowerCase();
  } catch {
    return "";
  }
}

function classifyAuthReason(status: number, payload: JsonRecord): KiroAuthFailureMetadata["reason"] {
  if (status === 401) return "unauthorized";
  const text = payloadSearchText(payload);
  if (/quota|entitlement|subscription|billing|plan|limit exceeded|too many requests/.test(text)) return "quota_or_entitlement";
  if (/auth[_-]?expired|token expired|expired token|expired.*token/.test(text)) return "auth_expired";
  if (/auth[_-]?rejected|token rejected|invalid token|invalid[_-]?grant|unauthorized/.test(text)) return "auth_rejected";
  return status === 403 ? "forbidden" : "http_error";
}

function isPotentiallyRefreshable(reason: KiroAuthFailureMetadata["reason"]): boolean {
  return reason === "unauthorized" || reason === "auth_expired" || reason === "auth_rejected";
}

function authFailureMessage(status: number, reason: KiroAuthFailureMetadata["reason"], credentialMode: KiroCredentialMode, refreshable: boolean, detail: string): string {
  const unmanagedSuffix = credentialMode === "env-token" ? " Static environment token mode is unmanaged and non-rotating; refresh retry is not available for this credential source." : "";
  const detailSuffix = detail && !detail.endsWith(".") ? ` Detail: ${detail}.` : detail ? ` Detail: ${detail}` : "";
  return `Kiro request failed with HTTP ${status} (${reason}); refreshable=${refreshable}; credentialMode=${credentialMode}.${unmanagedSuffix}${detailSuffix}`;
}

export function classifyKiroHttpFailure(status: number, payload: JsonRecord, credentialMode: KiroCredentialMode, providerId = "kiro"): Error {
  const reason = classifyAuthReason(status, payload);
  const potentiallyRefreshable = isPotentiallyRefreshable(reason);
  const metadata: KiroAuthFailureMetadata = {
    providerId,
    status,
    reason,
    refreshable: potentiallyRefreshable && credentialMode === "managed",
    credentialMode,
  };
  if (status === 401 || status === 403) {
    return new KiroAuthFailureError(authFailureMessage(status, reason, credentialMode, metadata.refreshable, extractErrorMessage(payload, status)), metadata);
  }
  return new Error(extractErrorMessage(payload, status));
}

function getKiroAuthFailure(error: unknown): KiroAuthFailureMetadata | undefined {
  return error instanceof KiroAuthFailureError ? error.kiroAuth : undefined;
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function acpPromptFromContext(context: Context): string {
  const sections: string[] = [];
  for (const message of context.messages) {
    let text = "";
    if (message.role === "assistant") {
      text = assistantText(message);
    } else if ("content" in message) {
      text = textFromContent(message.content as string | (TextContent | ImageContent)[]);
    }
    if (text) sections.push(`[${message.role}]\n${text}`);
  }
  return sections.join("\n\n");
}
type KiroAcpToolPermissions = {
  read: boolean;
  write: boolean;
  execute: boolean;
  toolNames: Set<string>;
};

interface KiroAcpTerminal {
  child: ReturnType<typeof spawn>;
  output: string;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus?: { exitCode: number | null; signal: string | null };
  exitPromise: Promise<void>;
}

function acpToolPermissions(context: Context): KiroAcpToolPermissions {
  const toolNames = new Set((context.tools ?? []).map((tool) => tool.name.toLowerCase()));
  const hasTool = (...names: string[]): boolean => names.some((name) => toolNames.has(name));
  return {
    read: hasTool("read", "fs_read", "grep", "glob", "find"),
    write: hasTool("write", "fs_write", "edit", "delete", "move"),
    execute: hasTool("shell", "bash", "execute_cmd", "execute_bash", "terminal"),
    toolNames,
  };
}

function acpPermissionAllowed(params: unknown, permissions: KiroAcpToolPermissions): boolean {
  const request = isRecord(params) && isRecord(params.toolCall) ? params.toolCall : undefined;
  const metadata = request && isRecord(request._meta) && isRecord(request._meta.kiro) ? request._meta.kiro : undefined;
  const toolName = optionalString(metadata?.toolName) ?? optionalString(request?.name);
  if (toolName) {
    const normalizedName = toolName.toLowerCase();
    if (permissions.toolNames.has(normalizedName)) return true;
    if (["read", "fs_read", "grep", "glob", "find"].includes(normalizedName)) return permissions.read;
    if (["write", "fs_write", "edit", "delete", "move"].includes(normalizedName)) return permissions.write;
    if (["shell", "bash", "execute_cmd", "execute_bash", "terminal"].includes(normalizedName)) return permissions.execute;
    return false;
  }
  const kind = optionalString(request?.kind);
  if (kind === "read" || kind === "search") return permissions.read;
  if (kind === "edit" || kind === "delete" || kind === "move") return permissions.write;
  if (kind === "execute") return permissions.execute;
  return false;
}

function readAcpText(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, Math.floor(line ?? 1) - 1);
  const count = limit == null ? lines.length - start : Math.max(0, Math.floor(limit));
  return lines.slice(start, start + count).join("\n");
}

function appendAcpTerminalOutput(terminal: KiroAcpTerminal, chunk: Uint8Array | string): void {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (!text) return;
  const combined = terminal.output + text;
  const bytes = Buffer.from(combined, "utf8");
  if (bytes.byteLength <= terminal.outputByteLimit) {
    terminal.output = combined;
    return;
  }
  terminal.output = bytes.subarray(bytes.byteLength - terminal.outputByteLimit).toString("utf8");
  terminal.truncated = true;
}

function createAcpTerminalManager(workingDirectory: string, permissions: KiroAcpToolPermissions) {
  const terminals = new Map<string, KiroAcpTerminal>();
  const getTerminal = (terminalId: string): KiroAcpTerminal => {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown ACP terminal: ${terminalId}`);
    return terminal;
  };

  const create = async (params: { command: string; args?: string[]; env?: Array<{ name: string; value: string }>; cwd?: string | null; outputByteLimit?: number | null }) => {
    if (!permissions.execute) throw new Error("ACP terminal access is not enabled for this request.");
    const outputByteLimit = typeof params.outputByteLimit === "number" && Number.isFinite(params.outputByteLimit) && params.outputByteLimit > 0
      ? Math.floor(params.outputByteLimit)
      : 1_000_000;
    const child = spawn(params.command, params.args ?? [], {
      cwd: resolve(params.cwd || workingDirectory),
      env: { ...process.env, ...Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminal: KiroAcpTerminal = {
      child,
      output: "",
      outputByteLimit,
      truncated: false,
      exitPromise: Promise.resolve(),
    };
    terminal.exitPromise = new Promise<void>((resolveExit) => {
      let settled = false;
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        terminal.exitStatus = { exitCode, signal };
        resolveExit();
      };
      child.once("exit", (exitCode, signal) => finish(exitCode, signal));
      child.once("error", (error) => {
        appendAcpTerminalOutput(terminal, `${error instanceof Error ? error.message : String(error)}\n`);
        finish(null, "error");
      });
    });
    child.stdout?.on("data", (chunk: Uint8Array) => appendAcpTerminalOutput(terminal, chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => appendAcpTerminalOutput(terminal, chunk));
    const terminalId = `kiro-terminal-${randomUUID()}`;
    terminals.set(terminalId, terminal);
    return { terminalId };
  };

  const output = async (params: { terminalId: string }) => {
    const terminal = getTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  };

  const waitForExit = async (params: { terminalId: string }) => {
    const terminal = getTerminal(params.terminalId);
    await terminal.exitPromise;
    return {
      exitCode: terminal.exitStatus?.exitCode ?? null,
      signal: terminal.exitStatus?.signal ?? null,
    };
  };

  const release = async (params: { terminalId: string }) => {
    const terminal = getTerminal(params.terminalId);
    if (!terminal.exitStatus) terminal.child.kill();
    terminals.delete(params.terminalId);
    return {};
  };

  const kill = async (params: { terminalId: string }) => {
    getTerminal(params.terminalId).child.kill();
    return {};
  };

  return {
    create,
    output,
    waitForExit,
    release,
    kill,
    dispose(): void {
      for (const terminal of terminals.values()) {
        if (!terminal.exitStatus) terminal.child.kill();
      }
      terminals.clear();
    },
  };
}

async function executeKiroAcpFallback(
  model: Model<Api>,
  context: Context,
  config: ExtensionConfig,
  stream: AssistantMessageEventStream,
): Promise<boolean> {
  const cliArgs = ["acp"];
  if (config.kiroCliAgent) cliArgs.push("--agent", config.kiroCliAgent);
  const child = spawn(config.kiroCliPath || "kiro-cli", cliArgs, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = createOutput(model);
  let fullText = "";
  let stopReason = "stop";
  const stderr: Uint8Array[] = [];
  child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));
  try {
    const acpStream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>);
    await client({ name: "omp-kiro-provider" })
      .onRequest(methods.client.session.requestPermission, async (params: unknown) => {
        const permissions = acpToolPermissions(context);
        if (acpPermissionAllowed(params, permissions)) return { outcome: { outcome: "selected", optionId: "allow" } };
        return { outcome: { outcome: "selected", optionId: "reject" } };
      })
      .connectWith(acpStream, async (connection: unknown) => {
        const conn = connection as {
          request: (method: string, params: object) => Promise<unknown>;
          onRequest: (method: string, handler: (params: unknown) => unknown) => void;
          buildSession: (cwd: string) => { start: () => Promise<{ prompt: (p: string) => Promise<unknown>, nextUpdate: () => Promise<{ kind: string, response: { stopReason: string }, notification: { update: { sessionUpdate: string, content: { type: string, text: string } } } }> }> };
        };
        await conn.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "omp-kiro-provider", version: "1.0.0" },
          clientCapabilities: {},
        });
        const terminalManager = createAcpTerminalManager(process.cwd(), acpToolPermissions(context));
        conn.onRequest(methods.client.terminal.create, terminalManager.create as (p: unknown) => unknown);
        conn.onRequest(methods.client.terminal.output, terminalManager.output as (p: unknown) => unknown);
        conn.onRequest(methods.client.terminal.waitForExit, terminalManager.waitForExit as (p: unknown) => unknown);
        conn.onRequest(methods.client.terminal.kill, terminalManager.kill as (p: unknown) => unknown);
        conn.onRequest(methods.client.terminal.release, terminalManager.release as (p: unknown) => unknown);
        const session = await conn.buildSession(process.cwd()).start();
        const promptPromise = session.prompt(acpPromptFromContext(context));
        for (;;) {
          const update = await session.nextUpdate();
          if (update.kind === "stop") {
            stopReason = update.response.stopReason;
            break;
          }
          const notification = update.notification.update;
          if (notification.sessionUpdate === "agent_message_chunk" && notification.content.type === "text") {
            if (!fullText) {
              output.content = [{ type: "text", text: "" }];
              stream.push({ type: "start", partial: output });
              stream.push({ type: "text_start", contentIndex: 0, partial: output });
            }
            fullText += notification.content.text;
            output.content = [{ type: "text", text: fullText }];
            output.usage = buildUsage(model, { input: 0, output: Math.max(1, Math.ceil(fullText.length / 4)), cacheRead: 0, cacheWrite: 0 });
            stream.push({ type: "text_delta", contentIndex: 0, delta: notification.content.text, partial: output });
          }
        }
        await promptPromise;
        return stopReason;
      });
    if (!fullText) {
      throw new Error(`Kiro ACP returned no text${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : ""}`);
    }
    stream.push({ type: "text_end", contentIndex: 0, content: fullText, partial: output });
    output.stopReason = "stop";
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end(output);
    return true;
  } catch {
    return false;
  } finally {
    child.kill();
  }
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildUsage(model: Model<Api>, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): Usage {
  const usage: Usage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function usageFromMetrics(model: Model<Api>, metrics: JsonRecord): Usage | undefined {
  const input = numberFrom(metrics.inputTokens);
  const output = numberFrom(metrics.outputTokens);
  const cacheRead = numberFrom(metrics.cacheReadTokens);
  const cacheWrite = numberFrom(metrics.cacheCreationTokens);
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) return undefined;
  return buildUsage(model, { input, output, cacheRead, cacheWrite });
}

function estimatedUsage(model: Model<Api>, state: KiroStreamState): Usage | undefined {
  const output = state.totalContentLength > 0 ? Math.max(1, Math.floor(state.totalContentLength / 4)) : 0;
  const input = state.contextUsagePercentage > 0 && model.contextWindow ? Math.floor((state.contextUsagePercentage * model.contextWindow) / 100) : 0;
  if (input <= 0 && output <= 0) return undefined;
  return buildUsage(model, { input, output, cacheRead: 0, cacheWrite: 0 });
}

function closeBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, kind: "text" | "thinking"): void {
  const contentIndex = kind === "text" ? state.textContentIndex : state.thinkingContentIndex;
  if (contentIndex === undefined) return;
  const block = output.content[contentIndex];
  let content = "";
  if (kind === "text" && block?.type === "text") content = block.text;
  else if (kind === "thinking" && block?.type === "thinking") content = block.thinking;
  stream.push({ type: kind === "text" ? "text_end" : "thinking_end", contentIndex, content, partial: output });
  if (kind === "text") state.textContentIndex = undefined;
  else state.thinkingContentIndex = undefined;
}

function closeTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  closeBlock(stream, output, state, "text");
}

function closeThinkingBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  closeBlock(stream, output, state, "thinking");
}

function ensureBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, kind: "text" | "thinking"): number {
  const existingIndex = kind === "text" ? state.textContentIndex : state.thinkingContentIndex;
  if (existingIndex !== undefined) return existingIndex;
  const contentIndex = output.content.length;
  if (kind === "text") {
    output.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex, partial: output });
    state.textContentIndex = contentIndex;
  } else {
    output.content.push({ type: "thinking", thinking: "" });
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    state.thinkingContentIndex = contentIndex;
  }
  return contentIndex;
}

function emitDelta(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, kind: "text" | "thinking", delta: string): void {
  if (!delta) return;
  if (kind === "text") closeThinkingBlock(stream, output, state);
  else closeTextBlock(stream, output, state);
  const contentIndex = ensureBlock(stream, output, state, kind);
  const block = output.content[contentIndex];
  if (kind === "text" && block?.type === "text") block.text += delta;
  else if (kind === "thinking" && block?.type === "thinking") block.thinking += delta;
  if (kind === "text") state.hasText = true;
  state.totalContentLength += delta.length;
  stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex, delta, partial: output });
}

function parseStreamingToolInput(toolCall: ToolCall, existingInputBuffer: string, rawInput: unknown): { delta: string; inputBuffer: string } {
  if (rawInput === undefined) return { delta: "", inputBuffer: existingInputBuffer };
  if (typeof rawInput === "string") {
    if (!rawInput) return { delta: "", inputBuffer: existingInputBuffer };
    const parsedInput = parseToolInput(rawInput);
    if (Object.keys(parsedInput).length > 0) {
      toolCall.arguments = parsedInput;
      return { delta: rawInput, inputBuffer: rawInput };
    }

    const inputBuffer = `${existingInputBuffer}${rawInput}`;
    toolCall.arguments = parseToolInput(inputBuffer);
    return { delta: rawInput, inputBuffer };
  }

  if (isRecord(rawInput)) {
    if (Object.keys(rawInput).length === 0) return { delta: "", inputBuffer: existingInputBuffer };
    const inputBuffer = JSON.stringify(rawInput);
    toolCall.arguments = rawInput;
    return { delta: inputBuffer, inputBuffer };
  }

  return { delta: "", inputBuffer: existingInputBuffer };
}

function ensureToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, payload: JsonRecord): KiroStreamingToolCall {
  const toolUseId = optionalString(payload.toolUseId) ?? `kiro-tool-${output.content.length}`;
  const existing = state.toolCallsById.get(toolUseId);
  if (existing) {
    const name = optionalString(payload.name);
    if (name && existing.toolCall.name === "tool") existing.toolCall.name = name;
    return existing;
  }

  const toolCall: ToolCall = {
    type: "toolCall",
    id: toolUseId,
    name: optionalString(payload.name) ?? "tool",
    arguments: {},
  };
  state.hasToolCalls = true;
  closeTextBlock(stream, output, state);
  closeThinkingBlock(stream, output, state);
  const contentIndex = output.content.length;
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  const entry: KiroStreamingToolCall = {
    contentIndex,
    toolCall,
    inputBuffer: "",
    ended: false,
  };
  state.toolCallsById.set(toolUseId, entry);
  return entry;
}

function emitToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, payload: JsonRecord): void {
  const entry = ensureToolCall(stream, output, state, payload);
  const { delta, inputBuffer } = parseStreamingToolInput(entry.toolCall, entry.inputBuffer, payload.input);
  entry.inputBuffer = inputBuffer;
  if (delta) stream.push({ type: "toolcall_delta", contentIndex: entry.contentIndex, delta, partial: output });
}

function closeToolCalls(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  for (const entry of state.toolCallsById.values()) {
    if (entry.ended) continue;
    entry.toolCall.arguments = parseToolInput(entry.inputBuffer);
    entry.ended = true;
    stream.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: entry.toolCall, partial: output });
  }
}

function getPayloadText(payload: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function getReasoningPayloadText(payload: JsonRecord): string {
  const direct = getPayloadText(payload, ["content", "text"]);
  if (direct) return direct;
  const nested = payload.reasoningContentEvent;
  return isRecord(nested) ? getPayloadText(nested, ["content", "text"]) : "";
}

function appendKiroMeteringDiagnostic(output: AssistantMessage, payload: JsonRecord): void {
  const usage = numberFrom(payload.usage);
  const unit = optionalString(payload.unit);
  const unitPlural = optionalString(payload.unitPlural);
  if (usage <= 0 && !unit && !unitPlural) return;
  const metadata = output as AssistantMessage & {
    kiroMetering?: Array<{ timestamp: number; usage: number; unit?: string; unitPlural?: string }>;
  };
  metadata.kiroMetering ??= [];
  metadata.kiroMetering.push({
    timestamp: Date.now(),
    usage,
    ...(unit ? { unit } : {}),
    ...(unitPlural ? { unitPlural } : {}),
  });
}

function captureResponseId(output: AssistantMessage, payload: JsonRecord): void {
  const messageId = optionalString(payload.messageId);
  if (messageId) output.responseId = messageId;
}

function handleEvent(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, model: Model<Api>, eventType: string, payload: JsonRecord | null): void {
  if (!payload) return;
  captureResponseId(output, payload);
  if (eventType === "assistantResponseEvent" || eventType === "codeEvent") {
    emitDelta(stream, output, state, "text", getPayloadText(payload, ["content", "text"]));
    return;
  }
  if (eventType === "reasoningContentEvent") {
    emitDelta(stream, output, state, "thinking", getReasoningPayloadText(payload));
    return;
  }
  if (eventType === "meteringEvent") {
    appendKiroMeteringDiagnostic(output, payload);
    return;
  }
  if (eventType === "toolUseEvent") {
    if (Array.isArray(payload)) {
      for (const entry of payload) if (isRecord(entry)) emitToolCall(stream, output, state, entry);
      return;
    }
    emitToolCall(stream, output, state, payload);
    return;
  }
  if (eventType === "contextUsageEvent") {
    const percentage = numberFrom(payload.contextUsagePercentage);
    if (percentage > 0) state.contextUsagePercentage = percentage;
    return;
  }
  if (eventType === "metricsEvent") {
    const metrics = isRecord(payload.metricsEvent) ? payload.metricsEvent : payload;
    state.usage = usageFromMetrics(model, metrics);
  }
}

async function consumeKiroEventStream(response: Response, stream: AssistantMessageEventStream, output: AssistantMessage, model: Model<Api>, logger: DebugLogger): Promise<void> {
  if (!response.body) throw new Error("Kiro response did not include a readable body.");
  const state: KiroStreamState = {
    hasText: false,
    hasToolCalls: false,
    toolCallsById: new Map(),
    totalContentLength: 0,
    contextUsagePercentage: 0,
  };
  const queue = new ByteQueue();
  stream.push({ type: "start", partial: output });

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    queue.push(chunk);
    let iterations = 0;
    while (queue.length >= 16 && iterations < 1000) {
      iterations += 1;
      const totalLength = queue.peekUint32BE(0);
      if (!totalLength || totalLength < 16 || totalLength > queue.length) break;
      const frameBytes = queue.read(totalLength);
      if (!frameBytes) break;
      const frame = parseEventFrame(frameBytes, logger);
      if (!frame) continue;
      handleEvent(stream, output, state, model, frame.headers[":event-type"] ?? "", frame.payload);
    }
    if (iterations >= 1000) logger.warn("eventstream_iteration_limit_reached", { remainingBytes: queue.length });
  }

  closeThinkingBlock(stream, output, state);
  closeTextBlock(stream, output, state);
  closeToolCalls(stream, output, state);
  output.usage = state.usage ?? estimatedUsage(model, state) ?? output.usage;
  output.stopReason = state.hasToolCalls ? "toolUse" : "stop";
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end(output);
}

async function executeKiroRequest(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<Api>,
  context: Context,
  config: ExtensionConfig,
  logger: DebugLogger,
  options?: SimpleStreamOptions,
): Promise<void> {
  let signal: { signal: AbortSignal; dispose(): void } | undefined;
  try {
    const credential = resolveKiroCredential(config, options);
    signal = createRequestSignal(options, config.requestTimeoutMs);
    const request = buildRequest(model, context, config, options);
    const payload = options?.onPayload ? (await options.onPayload(request, model)) ?? request : request;
    const currentContext = request.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    logger.debug("request_prepared", {
      model: model.id,
      endpoint: config.endpoint,
      toolNames: currentContext?.tools?.map((entry) => entry.toolSpecification.name) ?? [],
      toolResultCount: currentContext?.toolResults?.length ?? 0,
      historyLength: request.conversationState.history.length,
    });
    const response = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: buildHeaders(config, credential.apiKey, options),
      body: JSON.stringify(payload),
      signal: signal.signal,
    });

    await options?.onResponse?.({ status: response.status, headers: responseHeadersToRecord(response.headers) }, model);

    if (!response.ok) {
      const errorPayload = await readJsonResponse(response, "Kiro returned a non-object JSON response.");
      throw classifyKiroHttpFailure(response.status, errorPayload, credential.mode, config.providerId);
    }

    await consumeKiroEventStream(response, stream, output, model, logger);
  } catch (error) {
    const aborted = (signal?.signal.aborted ?? false) || error instanceof DOMException && error.name === "AbortError";
    output.stopReason = aborted ? "aborted" : "error";
    const authFailure = getKiroAuthFailure(error);
    if (authFailure && config.cliFallback && !aborted && await executeKiroAcpFallback(model, context, config, stream)) {
      logger.debug("request_fallback_to_kiro_cli", { model: model.id, authReason: authFailure.reason });
      return;
    }
    output.errorMessage = error instanceof Error ? redactSensitiveString(error.message) : "Unknown Kiro request error.";
    if (authFailure) {
      (output as AssistantMessage & { authFailure?: KiroAuthFailureMetadata; errorMetadata?: Record<string, unknown> }).authFailure = { ...authFailure };
      (output as AssistantMessage & { authFailure?: KiroAuthFailureMetadata; errorMetadata?: Record<string, unknown> }).errorMetadata = { providerId: "kiro", authFailure: { ...authFailure } };
    }
    logger.error("request_failed", { model: model.id, stopReason: output.stopReason, error });
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end(output);
  } finally {
    signal?.dispose();
  }
}

export function createKiroStream(config: ExtensionConfig, _runtime: KiroRuntimeState, logger: DebugLogger) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    void executeKiroRequest(stream, output, model, context, config, logger, options);
    return stream;
  };
}
