import { ResponsesProtocolError } from "./parser.js";
import { createHash } from "node:crypto";

const DEFAULT_CALL_ID_MAX_LENGTH = 64;

/**
 * Some Responses-compatible gateways limit `call_id` values while DSH keeps
 * the provider/tool correlation id without imposing that limit. Hash only
 * oversized ids so compliant provider ids remain readable.  This is
 * deterministic across requests: a retained tool result can therefore still
 * refer to a call that has fallen outside a later context window.
 */
function compatibleCallId(callId, maxLength) {
  if (callId.length <= maxLength) return callId;
  const prefix = "call_";
  if (maxLength < prefix.length + 1) {
    throw new ResponsesProtocolError(
      "Responses callIdMaxLength must be at least 6",
      "INVALID_CONFIG",
    );
  }
  return `${prefix}${createHash("sha256")
    .update(callId)
    .digest("hex")
    .slice(0, maxLength - prefix.length)}`;
}

function textOf(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n");
}

function messageText(message) {
  const text = textOf(message.content ?? []);
  return text || "(no content)";
}

function assistantInput(message, callId) {
  const input = [];
  let messageContent = [];
  const flushMessage = () => {
    if (messageContent.length === 0) return;
    input.push({ type: "message", role: "assistant", content: messageContent });
    messageContent = [];
  };
  for (const block of message.content ?? []) {
    if (block.type === "text")
      messageContent.push({ type: "output_text", text: block.text });
    else if (block.type === "reasoning") {
      flushMessage();
      input.push({
        type: "reasoning",
        summary: [{ type: "summary_text", text: block.text }],
      });
    } else if (block.type === "tool-call") {
      flushMessage();
      input.push({
        type: "function_call",
        call_id: callId(block.id),
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
  flushMessage();
  return input;
}

function inputItem(message, callId) {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: [{ type: "input_text", text: messageText(message) }],
      };
    case "system":
    case "developer":
      return {
        role: "developer",
        content: [{ type: "input_text", text: messageText(message) }],
      };
    case "assistant":
      return assistantInput(message, callId);
    case "tool":
      return {
        type: "function_call_output",
        call_id: callId(message.toolCallId),
        output: messageText(message),
      };
    default:
      throw new ResponsesProtocolError(
        `Responses adapter cannot serialize message role ${String(message.role)}`,
        "UNSUPPORTED_CONTENT",
      );
  }
}

function flattenInput(messages, callId) {
  const input = [];
  for (const message of messages ?? []) {
    const item = inputItem(message, callId);
    if (Array.isArray(item)) input.push(...item);
    else input.push(item);
  }
  return input;
}

function toolDefinition(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

/** Convert one DSH GenerateOptions object to an OpenAI Responses request body. */
export function serializeResponsesRequest(
  options,
  { callIdMaxLength = DEFAULT_CALL_ID_MAX_LENGTH } = {},
) {
  if (options.stop !== undefined) {
    throw new ResponsesProtocolError(
      "Responses WebSocket adapter does not support stop sequences",
      "UNSUPPORTED_OPTION",
    );
  }
  if (!Number.isSafeInteger(callIdMaxLength) || callIdMaxLength < 6) {
    throw new ResponsesProtocolError(
      "Responses callIdMaxLength must be an integer of at least 6",
      "INVALID_CONFIG",
    );
  }
  const input = flattenInput(options.messages, (callId) =>
    compatibleCallId(callId, callIdMaxLength),
  );
  const body = {
    type: "response.create",
    model: options.model,
    stream: true,
    store: false,
    input,
    ...(options.system ? { instructions: options.system } : {}),
    ...(options.maxTokens !== undefined
      ? { max_output_tokens: options.maxTokens }
      : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.reasoningEffort !== undefined
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
  };
  const tools = (options.tools ?? []).filter(
    (tool) => tool.deferLoading !== true,
  );
  if (tools.length > 0) body.tools = tools.map(toolDefinition);
  return body;
}

export function responsesSsePayload(request) {
  const { type: _type, ...payload } = request;
  return payload;
}
