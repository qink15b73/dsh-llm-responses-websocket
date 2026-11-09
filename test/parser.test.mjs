import test from "node:test";
import assert from "node:assert/strict";
import { translateResponsesEvents } from "../parser.js";

async function* events(values) {
  for (const value of values) yield value;
}

async function collect(values) {
  const chunks = [];
  for await (const chunk of translateResponsesEvents(events(values)))
    chunks.push(chunk);
  return chunks;
}

test("accepts metadata before response.created and emits text completion", async () => {
  const created = [];
  const chunks = [];
  const stream = translateResponsesEvents(
    events([
      { type: "response.metadata", headers: {} },
      { type: "codex.response.metadata", headers: {} },
      {
        type: "response.created",
        response: { id: "resp_1", status: "in_progress" },
      },
      {
        type: "response.in_progress",
        response: { id: "resp_1", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message" },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "OK",
      },
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "OK" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        },
      },
    ]),
    { onCreated: (id) => created.push(id) },
  );
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(created, ["resp_1"]);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "OK" },
    { type: "block-end", index: 0, block: { type: "text", text: "OK" } },
    {
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    },
    {
      type: "finish",
      reason: { kind: "stop" },
      replayState: { version: 1, providerResponseId: "resp_1" },
    },
  ]);
});

test("keeps text and reasoning parts from one response output item distinct", async () => {
  const chunks = await collect([
    {
      type: "response.created",
      response: { id: "resp_2", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message" },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning", summary: "" },
    },
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "think",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning", summary: "think" },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 1,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 1,
      delta: "answer",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 1,
      part: { type: "output_text", text: "answer" },
    },
    {
      type: "response.completed",
      response: { id: "resp_2", status: "completed" },
    },
  ]);

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      "block-start",
      "reasoning-delta",
      "block-end",
      "block-start",
      "text-delta",
      "block-end",
      "finish",
    ],
  );
  assert.equal(chunks[0].blockType, "reasoning");
  assert.equal(chunks[3].blockType, "text");
});

test("converts function-call argument streaming to a tool-call finish", async () => {
  const chunks = await collect([
    {
      type: "response.created",
      response: { id: "resp_tool", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"q":',
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: '{"q":"x"}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
    },
    {
      type: "response.completed",
      response: { id: "resp_tool", status: "completed" },
    },
  ]);

  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 0,
      id: "call_1",
      name: "lookup",
      argumentsDelta: "",
    },
    {
      type: "tool-call-delta",
      index: 0,
      id: "call_1",
      argumentsDelta: '{"q":',
    },
    {
      type: "block-end",
      index: 0,
      block: {
        type: "tool-call",
        id: "call_1",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
    },
    {
      type: "finish",
      reason: { kind: "tool-calls" },
      replayState: { version: 1, providerResponseId: "resp_tool" },
    },
  ]);
});

test("rejects a stream that ends without a terminal response event", async () => {
  await assert.rejects(collect([{ type: "response.metadata", headers: {} }]), {
    code: "STREAM_CLOSED",
  });
});
