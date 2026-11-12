import test from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  configuredPiAiProfiles,
  resolvedPiAiProfiles,
} from "../index.js";

function streamContext(profiles, adapter) {
  let listener;
  const ctx = {
    llm: {
      adapters: new Map([["gateway", { adapter }]]),
    },
    get(name) {
      if (name !== "settings") return undefined;
      return {
        describe: () => [{ ns: "llm-pi-ai", value: { providers: profiles } }],
      };
    },
    on(name, callback) {
      assert.equal(name, "llm/stream");
      listener = callback;
      return () => {};
    },
  };
  apply(ctx);
  return { ctx, stream: (...args) => listener(...args) };
}

test("reads the provider profiles owned by native pi-ai settings", () => {
  const profiles = { gateway: { transport: "websocket" } };
  const { ctx } = streamContext(profiles, {});
  assert.equal(configuredPiAiProfiles(ctx), profiles);
});

test("prefers a registered adapter's resolved profile map", () => {
  const profiles = new Map([["gateway", { transport: "websocket" }]]);
  const { ctx } = streamContext({}, { current: () => ({ profiles }) });
  assert.equal(resolvedPiAiProfiles(ctx, "gateway"), profiles);
});

test("intercepts selected calls through the stream waterfall and rechecks settings", () => {
  const adapter = {};
  const profiles = {
    gateway: {
      api: "openai-responses",
      baseURL: "https://gateway.example/v1",
      transport: "websocket",
    },
  };
  const { stream } = streamContext(profiles, adapter);
  let nativeCalls = 0;
  const next = () => {
    nativeCalls += 1;
    return "native";
  };

  const selected = stream({ provider: "gateway", model: "model-a" }, next);
  assert.equal(typeof selected[Symbol.asyncIterator], "function");
  assert.equal(nativeCalls, 0);

  profiles.gateway.transport = "auto";
  assert.equal(stream({ provider: "gateway", model: "model-a" }, next), "native");
  assert.equal(nativeCalls, 1);
});
