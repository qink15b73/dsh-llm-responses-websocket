import test from "node:test";
import assert from "node:assert/strict";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai-native";
import {
  ResponsesWebSocketRouter,
  interceptPiAiRegistration,
} from "../index.js";

function nativeAdapter() {
  return new PiAiAdapter({
    profiles: () => new Map(),
    resolveApiKey: async () => undefined,
    auth: {},
  });
}

test("wraps pi-ai registrations added after startup without changing other adapters", () => {
  const calls = [];
  const llm = {
    registerAdapter(providers, adapter) {
      calls.push({ providers, adapter });
      return { replace() {} };
    },
  };
  const ctx = { llm, get: () => undefined };
  const original = llm.registerAdapter;
  const restore = interceptPiAiRegistration(ctx, () => ({}));
  const pi = nativeAdapter();
  const unrelated = {};

  llm.registerAdapter(["later-provider"], pi);
  llm.registerAdapter(["another-provider"], unrelated);

  assert.deepEqual(calls[0].providers, ["later-provider"]);
  assert.ok(calls[0].adapter instanceof ResponsesWebSocketRouter);
  assert.equal(calls[1].adapter, unrelated);

  restore();
  assert.equal(llm.registerAdapter, original);
});
