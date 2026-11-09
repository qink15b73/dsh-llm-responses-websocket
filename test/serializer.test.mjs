import test from "node:test";
import assert from "node:assert/strict";
import { serializeResponsesRequest } from "../serializer.js";

test("uses one compatible call id for a long historical call and its result", () => {
  const longCallId = `call_${"a".repeat(86)}`;
  assert.equal(longCallId.length, 91);

  const request = serializeResponsesRequest({
    model: "example-model",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: longCallId,
            name: "lookup",
            arguments: '{"query":"example"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: longCallId,
        content: [{ type: "text", text: "result" }],
      },
    ],
  });

  const [call, result] = request.input;
  assert.equal(call.call_id.length <= 64, true);
  assert.equal(result.call_id.length <= 64, true);
  assert.equal(result.call_id, call.call_id);
  assert.notEqual(call.call_id, longCallId);
});

test("preserves already compliant call ids", () => {
  const request = serializeResponsesRequest({
    model: "example-model",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "call_short",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
    ],
  });

  assert.equal(request.input[0].call_id, "call_short");
});

test("serializes historical assistant text as a supported message input item", () => {
  const request = serializeResponsesRequest({
    model: "example-model",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Previous answer." }],
      },
    ],
  });

  assert.deepEqual(request.input, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Previous answer." }],
    },
  ]);
});

test("keeps historical function calls as supported top-level input items", () => {
  const request = serializeResponsesRequest({
    model: "example-model",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will look that up." },
          {
            type: "tool-call",
            id: "call_lookup",
            name: "lookup",
            arguments: '{"q":"example"}',
          },
        ],
      },
    ],
  });

  assert.deepEqual(request.input, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I will look that up." }],
    },
    {
      type: "function_call",
      call_id: "call_lookup",
      name: "lookup",
      arguments: '{"q":"example"}',
    },
  ]);
});

test("maps one long call id identically across independently serialized requests", () => {
  const longCallId = `call_${"z".repeat(86)}`;
  const messages = [
    {
      role: "tool",
      toolCallId: longCallId,
      content: [{ type: "text", text: "result" }],
    },
  ];

  const first = serializeResponsesRequest({ model: "example-model", messages });
  const second = serializeResponsesRequest({
    model: "example-model",
    messages,
  });

  assert.equal(first.input[0].call_id, second.input[0].call_id);
  assert.equal(first.input[0].call_id.length, 64);
});
