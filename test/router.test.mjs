import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  createResponsesWebSocketRouter,
  usesCompatibleWebSocket,
} from "../router.js";

const profile = {
  api: "openai-responses",
  baseURL: "https://gateway.example/v1",
  apiKeyEnv: "GATEWAY_KEY",
  transport: "websocket",
};

function piAdapter() {
  return {
    providerInfo: (provider) => ({ id: provider, name: "Gateway" }),
    providerRetryPolicy: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({
      ...image,
      delegated: true,
    }),
    listModels: async (provider) => [
      { provider, id: "model-a", name: "Model A" },
    ],
    resolveModel: async (provider, model) => ({
      provider,
      id: model,
      name: "Model A",
    }),
    prepareCall: async (provider, model) => ({
      model: { provider, id: model },
      stream: async function* () {
        yield { delegated: true };
      },
    }),
    stream: async function* () {
      yield { delegated: true };
    },
  };
}

test("only compatible Responses profiles select the WebSocket router", () => {
  assert.equal(usesCompatibleWebSocket(profile), true);
  assert.equal(
    usesCompatibleWebSocket({ ...profile, transport: "auto" }),
    false,
  );
  assert.equal(
    usesCompatibleWebSocket({ ...profile, api: "anthropic-messages" }),
    false,
  );
});

test("delegates non-WebSocket providers to pi-ai unchanged", async () => {
  const adapter = createResponsesWebSocketRouter(
    { get: () => undefined },
    () => ({ gateway: { ...profile, transport: "auto" } }),
    piAdapter(),
  );
  const prepared = await adapter.prepareCall("gateway", "model-a");
  const chunks = [];
  for await (const chunk of prepared.stream({
    provider: "gateway",
    model: "model-a",
  }))
    chunks.push(chunk);
  assert.deepEqual(chunks, [{ delegated: true }]);
});

test("rechecks transport selection when a prepared call is dispatched", async () => {
  let profiles = { gateway: profile };
  const adapter = createResponsesWebSocketRouter(
    { get: () => undefined },
    () => profiles,
    piAdapter(),
  );
  const prepared = await adapter.prepareCall("gateway", "model-a");
  profiles = { gateway: { ...profile, transport: "auto" } };
  const chunks = [];
  for await (const chunk of prepared.stream({
    provider: "gateway",
    model: "model-a",
  })) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [{ delegated: true }]);
});

test("preserves pi-ai provider and model metadata for WebSocket providers", async () => {
  const adapter = createResponsesWebSocketRouter(
    { get: () => undefined },
    () => ({ gateway: profile }),
    piAdapter(),
  );
  assert.deepEqual(adapter.providerInfo("gateway"), {
    id: "gateway",
    name: "Gateway",
  });
  assert.deepEqual(await adapter.listModels("gateway"), [
    { provider: "gateway", id: "model-a", name: "Model A" },
  ]);
  assert.deepEqual(await adapter.resolveModel("gateway", "model-a"), {
    provider: "gateway",
    id: "model-a",
    name: "Model A",
  });
});

test("keeps native image preparation for WebSocket providers", () => {
  const adapter = createResponsesWebSocketRouter(
    { get: () => undefined },
    () => ({ gateway: profile }),
    piAdapter(),
  );
  assert.deepEqual(
    adapter.imageRequestTarget("gateway", "model-a", {
      width: 100,
      height: 50,
      bytes: 900,
    }),
    {
      width: 100,
      height: 50,
      bytes: 900,
      delegated: true,
    },
  );
});

test("uses the pi-ai request-header waterfall without a native adapter handle", async () => {
  const seen = [];
  const adapter = createResponsesWebSocketRouter(
    {
      get: () => undefined,
      waterfall(name, request, headers, next) {
        seen.push({ name, request });
        headers.set("x-request-hook", "applied");
        return next();
      },
    },
    () => ({ gateway: profile }),
  );
  const headers = await adapter.requestHeaders(
    { provider: "gateway", model: "model-a" },
    profile,
  );

  assert.equal(headers["x-request-hook"], "applied");
  assert.deepEqual(seen, [
    {
      name: "llm-pi-ai/request-headers",
      request: {
        provider: "gateway",
        model: "model-a",
        baseURL: "https://gateway.example/v1",
      },
    },
  ]);
});

test("streams a selected provider through the Responses WebSocket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  let received;
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer native-key");
    assert.equal(request.headers["x-native-hook"], "applied");
    socket.once("message", (frame) => {
      received = JSON.parse(frame.toString());
      for (const event of [
        {
          type: "response.created",
          response: { id: "resp_test", status: "in_progress" },
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
          delta: "hello",
        },
        {
          type: "response.content_part.done",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "hello" },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_test",
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        },
      ]) {
        socket.send(JSON.stringify(event));
      }
    });
  });

  try {
    const nativeProfile = { id: "native-profile" };
    let credentialResolution;
    const nativeAdapter = {
      ...piAdapter(),
      current: () => ({ profiles: new Map([["gateway", nativeProfile]]) }),
      profileOf: (snapshot, provider) => snapshot.profiles.get(provider),
      config: {
        resolveApiKey: async (provider, resolvedProfile) => {
          credentialResolution = { provider, resolvedProfile };
          return "native-key";
        },
        prepareHeaders: (request, headers) => {
          assert.deepEqual(request, {
            provider: "gateway",
            model: "model-a",
            baseURL: `http://127.0.0.1:${port}/v1`,
          });
          headers.set("x-native-hook", "applied");
          return headers;
        },
      },
    };
    const adapter = createResponsesWebSocketRouter(
      {
        get(name) {
          return name === "credentials"
            ? { resolve: async () => ({ value: "wrong-key" }) }
            : undefined;
        },
      },
      () => ({
        gateway: {
          ...profile,
          baseURL: `http://127.0.0.1:${port}/v1`,
        },
      }),
      nativeAdapter,
    );
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: "gateway",
      model: "model-a",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    })) {
      chunks.push(chunk);
    }

    assert.deepEqual(received, {
      type: "response.create",
      model: "model-a",
      stream: true,
      store: false,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
      ],
    });
    assert.deepEqual(credentialResolution, {
      provider: "gateway",
      resolvedProfile: nativeProfile,
    });
    assert.deepEqual(chunks, [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "hello" },
      {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "hello" },
      },
      {
        type: "usage",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      },
      {
        type: "finish",
        reason: { kind: "stop" },
        replayState: { version: 1, providerResponseId: "resp_test" },
      },
    ]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
