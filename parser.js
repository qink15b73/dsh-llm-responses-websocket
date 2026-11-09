/**
 * Translate OpenAI Responses events into DSH stream chunks.
 *
 * Some compatible gateways emit metadata frames before `response.created`; those frames are
 * deliberately non-semantic and never start a DSH response or output block.
 */

export class ResponsesProtocolError extends Error {
  constructor(message, code = "MALFORMED_RESPONSE", options = undefined) {
    super(message, options);
    this.name = "ResponsesProtocolError";
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function string(value) {
  return typeof value === "string" ? value : undefined;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function eventType(event) {
  const type = string(object(event)?.type);
  if (!type)
    throw new ResponsesProtocolError("Responses event has no string type");
  return type;
}

function responseError(response) {
  const error = object(response)?.error;
  const message = string(error?.message);
  const code = string(error?.code);
  return {
    message: message ?? "Responses request failed",
    code: code ?? "PROVIDER_ERROR",
  };
}

function mapStopReason(response, hasToolCall) {
  const status = string(object(response)?.status);
  if (status === "incomplete") {
    const reason = string(object(response)?.incomplete_details)?.reason;
    return reason === "max_output_tokens" || reason === "max_tokens"
      ? { kind: "max-tokens" }
      : {
          kind: "error",
          failure: {
            message: `Responses request incomplete${reason ? `: ${reason}` : ""}`,
            code: "INCOMPLETE_RESPONSE",
          },
        };
  }
  if (status === "failed") {
    const error = responseError(response);
    return { kind: "error", failure: error };
  }
  if (status !== undefined && status !== "completed") {
    return {
      kind: "error",
      failure: {
        message: `Responses request ended with status ${status}`,
        code: "PROVIDER_ERROR",
      },
    };
  }
  return hasToolCall ? { kind: "tool-calls" } : { kind: "stop" };
}

function usageOf(response) {
  const usage = object(object(response)?.usage);
  if (!usage) return undefined;
  const inputTokens = number(usage.input_tokens) ?? 0;
  const outputTokens = number(usage.output_tokens) ?? 0;
  const totalTokens = number(usage.total_tokens) ?? inputTokens + outputTokens;
  const cached = number(object(usage.input_tokens_details)?.cached_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached && cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

function partKey(outputIndex, contentIndex = 0) {
  return `part:${outputIndex}:${contentIndex}`;
}

function toolKey(outputIndex) {
  return `tool:${outputIndex}`;
}

function slotFor(slots, key, expected) {
  const slot = slots.get(key);
  if (!slot || (expected !== undefined && slot.kind !== expected))
    return undefined;
  return slot;
}

function startSlot(slots, key, kind, data) {
  const existing = slots.get(key);
  if (existing) return existing;
  const index = slots.size;
  const slot = { index, kind, closed: false, text: "", ...data };
  slots.set(key, slot);
  return slot;
}

function blockTypeForPart(part) {
  switch (string(object(part)?.type)) {
    case "output_text":
    case "text":
      return "text";
    case "reasoning":
    case "reasoning_summary":
      return "reasoning";
    default:
      return undefined;
  }
}

function initialPartText(part) {
  const value = object(part);
  return string(value?.text) ?? string(value?.summary) ?? "";
}

function closeSlot(slot) {
  if (slot.closed) return undefined;
  slot.closed = true;
  if (slot.kind === "tool-call") {
    return {
      type: "block-end",
      index: slot.index,
      block: {
        type: "tool-call",
        id: slot.id,
        name: slot.name,
        arguments: slot.arguments,
      },
    };
  }
  return {
    type: "block-end",
    index: slot.index,
    block: { type: slot.kind, text: slot.text },
  };
}

/**
 * @param {AsyncIterable<object>} events provider events in arrival order
 * @param {{ onCreated?: (id: string) => void }} hooks lifecycle callbacks
 */
export async function* translateResponsesEvents(events, hooks = {}) {
  const slots = new Map();
  let terminal = undefined;
  let responseId = undefined;

  for await (const event of events) {
    const type = eventType(event);

    // These are intentionally allowed before response.created. They carry
    // transport/proxy diagnostics, not response lifecycle semantics.
    if (
      type === "response.metadata" ||
      type === "codex.response.metadata" ||
      type === "responsesapi.websocket_timing"
    )
      continue;

    if (type === "response.created") {
      const id = string(object(event.response)?.id);
      if (id) {
        responseId = id;
        hooks.onCreated?.(id);
      }
      continue;
    }

    if (type === "response.in_progress" || type === "response.queued") continue;

    if (type === "error") {
      const error = object(event.error) ?? event;
      throw new ResponsesProtocolError(
        string(error.message) ?? "Responses endpoint emitted an error event",
        string(error.code) ?? "PROVIDER_ERROR",
      );
    }

    if (type === "response.failed") {
      const error = responseError(event.response);
      throw new ResponsesProtocolError(error.message, error.code);
    }

    if (type === "response.output_item.added") {
      const outputIndex = number(event.output_index);
      const item = object(event.item);
      if (outputIndex === undefined || !item)
        throw new ResponsesProtocolError(
          "Responses output item added event is malformed",
        );
      if (item.type === "function_call" || item.type === "tool_call") {
        const id = string(item.call_id) ?? string(item.id);
        const name = string(item.name);
        if (!id || !name)
          throw new ResponsesProtocolError(
            "Responses function call is missing call_id or name",
          );
        const slot = startSlot(slots, toolKey(outputIndex), "tool-call", {
          id,
          name,
          arguments: string(item.arguments) ?? "",
        });
        yield {
          type: "block-start",
          index: slot.index,
          blockType: "tool-call",
        };
        yield {
          type: "tool-call-delta",
          index: slot.index,
          id: slot.id,
          name: slot.name,
          argumentsDelta: slot.arguments,
        };
      }
      continue;
    }

    if (type === "response.content_part.added") {
      const outputIndex = number(event.output_index);
      const contentIndex = number(event.content_index) ?? 0;
      const kind = blockTypeForPart(event.part);
      if (outputIndex === undefined || !kind) continue;
      const slot = startSlot(slots, partKey(outputIndex, contentIndex), kind);
      yield { type: "block-start", index: slot.index, blockType: slot.kind };
      const text = initialPartText(event.part);
      if (text) {
        slot.text += text;
        yield {
          type: slot.kind === "text" ? "text-delta" : "reasoning-delta",
          index: slot.index,
          text,
        };
      }
      continue;
    }

    if (type === "response.output_text.delta") {
      const outputIndex = number(event.output_index);
      const contentIndex = number(event.content_index) ?? 0;
      const delta = string(event.delta);
      if (outputIndex === undefined || delta === undefined)
        throw new ResponsesProtocolError(
          "Responses output text delta is malformed",
        );
      let slot = slotFor(slots, partKey(outputIndex, contentIndex), "text");
      if (!slot) {
        slot = startSlot(slots, partKey(outputIndex, contentIndex), "text");
        yield { type: "block-start", index: slot.index, blockType: "text" };
      }
      slot.text += delta;
      yield { type: "text-delta", index: slot.index, text: delta };
      continue;
    }

    if (
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta"
    ) {
      const outputIndex = number(event.output_index);
      const contentIndex = number(event.content_index) ?? 0;
      const delta = string(event.delta);
      if (outputIndex === undefined || delta === undefined)
        throw new ResponsesProtocolError(
          "Responses reasoning delta is malformed",
        );
      let slot = slotFor(
        slots,
        partKey(outputIndex, contentIndex),
        "reasoning",
      );
      if (!slot) {
        slot = startSlot(
          slots,
          partKey(outputIndex, contentIndex),
          "reasoning",
        );
        yield {
          type: "block-start",
          index: slot.index,
          blockType: "reasoning",
        };
      }
      slot.text += delta;
      yield { type: "reasoning-delta", index: slot.index, text: delta };
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const outputIndex = number(event.output_index);
      const delta = string(event.delta);
      const slot =
        outputIndex === undefined
          ? undefined
          : slotFor(slots, toolKey(outputIndex), "tool-call");
      if (!slot || delta === undefined)
        throw new ResponsesProtocolError(
          "Responses function-call argument delta has no open tool call",
        );
      slot.arguments += delta;
      yield {
        type: "tool-call-delta",
        index: slot.index,
        id: slot.id,
        argumentsDelta: delta,
      };
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const outputIndex = number(event.output_index);
      const slot =
        outputIndex === undefined
          ? undefined
          : slotFor(slots, toolKey(outputIndex), "tool-call");
      if (!slot) continue;
      const complete = string(event.arguments);
      if (complete !== undefined) slot.arguments = complete;
      continue;
    }

    if (type === "response.content_part.done") {
      const outputIndex = number(event.output_index);
      const contentIndex = number(event.content_index) ?? 0;
      if (outputIndex === undefined) continue;
      const slot = slots.get(partKey(outputIndex, contentIndex));
      if (!slot || slot.kind === "tool-call") continue;
      const text = initialPartText(event.part);
      if (text && slot.text.length === 0) slot.text = text;
      const chunk = closeSlot(slot);
      if (chunk) yield chunk;
      continue;
    }

    if (type === "response.output_item.done") {
      const outputIndex = number(event.output_index);
      if (outputIndex === undefined) continue;
      const item = object(event.item);
      const slot =
        item?.type === "function_call" || item?.type === "tool_call"
          ? slots.get(toolKey(outputIndex))
          : undefined;
      if (!slot) continue;
      if (slot.kind === "tool-call") {
        const argumentsText = string(item?.arguments);
        if (argumentsText !== undefined) slot.arguments = argumentsText;
      }
      const chunk = closeSlot(slot);
      if (chunk) yield chunk;
      continue;
    }

    if (type === "response.completed" || type === "response.incomplete") {
      terminal = object(event.response) ?? {
        status: type === "response.completed" ? "completed" : "incomplete",
      };
      for (const slot of slots.values()) {
        const chunk = closeSlot(slot);
        if (chunk) yield chunk;
      }
      const hasToolCall = [...slots.values()].some(
        (slot) => slot.kind === "tool-call",
      );
      const reason = mapStopReason(terminal, hasToolCall);
      if (reason.kind === "error") {
        yield { type: "finish", reason };
        return;
      }
      const usage = usageOf(terminal);
      if (usage) yield { type: "usage", usage };
      yield {
        type: "finish",
        reason,
        ...(responseId
          ? { replayState: { version: 1, providerResponseId: responseId } }
          : {}),
      };
      return;
    }
  }

  throw new ResponsesProtocolError(
    "Responses stream closed before a terminal response event",
    "STREAM_CLOSED",
  );
}
