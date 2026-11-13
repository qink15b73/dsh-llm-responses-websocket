import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { ResponsesProtocolError, translateResponsesEvents } from "./parser.js";
import { serializeResponsesRequest } from "./serializer.js";
import { streamWebSocket } from "./transport.js";

const WEBSOCKET_PROTOCOLS = new Set([
  "openai-responses",
  "openai-codex-responses",
]);
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const HANDSHAKE_RETRIES = 4;
const HANDSHAKE_RETRY_INITIAL_DELAY_MS = 1_000;
const HANDSHAKE_RETRY_MAX_DELAY_MS = 8_000;
const CALL_ID_MAX_LENGTH = 64;

function profileFor(profiles, provider) {
  const profile =
    typeof profiles?.get === "function"
      ? profiles.get(provider)
      : profiles?.[provider];
  return profile && typeof profile === "object" ? profile : undefined;
}

export function usesCompatibleWebSocket(profile) {
  return (
    profile?.transport === "websocket" && WEBSOCKET_PROTOCOLS.has(profile.api)
  );
}

function profileSnapshot(profile) {
  if (!usesCompatibleWebSocket(profile)) {
    throw new LlmError(
      "Responses WebSocket routing requires an OpenAI Responses provider with transport set to websocket",
      "INVALID_CONFIG",
    );
  }
  if (typeof profile.baseURL !== "string" || profile.baseURL.length === 0) {
    throw new LlmError(
      "Responses WebSocket provider baseURL must be a non-empty URL",
      "INVALID_CONFIG",
    );
  }
  try {
    new URL(profile.baseURL);
  } catch (cause) {
    throw new LlmError(
      "Responses WebSocket provider baseURL must be a valid URL",
      "INVALID_CONFIG",
      { cause },
    );
  }
  if (
    profile.headers !== undefined &&
    (profile.headers === null ||
      typeof profile.headers !== "object" ||
      Array.isArray(profile.headers))
  ) {
    throw new LlmError(
      "Responses WebSocket provider headers must be an object",
      "INVALID_CONFIG",
    );
  }
  const connectTimeoutMs =
    profile.websocketConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new LlmError(
      "Responses WebSocket websocketConnectTimeoutMs must be a positive integer",
      "INVALID_CONFIG",
    );
  }
  return {
    baseURL: profile.baseURL,
    apiKeyEnv: profile.apiKeyEnv,
    headers: { ...(profile.headers ?? {}) },
    connectTimeoutMs,
  };
}

async function resolveApiKey(ctx, piAdapter, provider, reference) {
  if (
    typeof piAdapter?.current === "function" &&
    typeof piAdapter?.profileOf === "function" &&
    typeof piAdapter?.config?.resolveApiKey === "function"
  ) {
    const snapshot = piAdapter.current();
    const nativeProfile = piAdapter.profileOf(snapshot, provider);
    const resolved = await piAdapter.config.resolveApiKey(
      provider,
      nativeProfile,
    );
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved.trim();
    }
    throw new LlmError(
      `Responses WebSocket provider "${provider}" has no usable API key`,
      "MISSING_CREDENTIAL",
    );
  }
  if (typeof reference !== "string" || reference.length === 0) {
    throw new LlmError(
      `Responses WebSocket provider "${provider}" requires an API-key credential`,
      "MISSING_CREDENTIAL",
    );
  }
  const credentials = ctx.get("credentials");
  const stored =
    credentials === undefined
      ? undefined
      : await credentials.resolve(reference);
  const value =
    stored?.value ??
    launchEnvironmentOf(ctx).get(reference)?.value ??
    process.env[reference];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new LlmError(
    `Responses WebSocket credential "${reference}" is not available`,
    "MISSING_CREDENTIAL",
  );
}

function normalizeError(error, signal) {
  if (error instanceof LlmError) return error;
  if (signal?.aborted)
    return new LlmError(
      "Responses WebSocket request aborted by caller",
      "ABORTED",
      { cause: error },
    );
  if (error instanceof ResponsesProtocolError)
    return new LlmError(error.message, error.code, { cause: error });
  return new LlmError("Responses WebSocket transport failed", "TRANSPORT", {
    cause: error,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry only failures explicitly marked as pre-request handshake failures. */
export async function* streamWebSocketWithHandshakeRetries(
  streamFactory,
  options,
  retries = HANDSHAKE_RETRIES,
  initialRetryDelayMs = HANDSHAKE_RETRY_INITIAL_DELAY_MS,
  sleep = wait,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      yield* streamFactory(options);
      return;
    } catch (error) {
      if (error?.safeToFallback !== true || attempt >= retries) throw error;
      const retryDelayMs = Math.min(
        initialRetryDelayMs * 2 ** attempt,
        HANDSHAKE_RETRY_MAX_DELAY_MS,
      );
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
}

/**
 * Preserves the native pi-ai adapter for all ordinary routes. Routes whose
 * native provider profile explicitly selects `transport: websocket` are sent
 * over the compatible Responses WebSocket instead.
 */
export class ResponsesWebSocketRouter extends LlmAdapter {
  constructor(ctx, profiles, piAdapter) {
    super();
    this.ctx = ctx;
    this.profiles = profiles;
    this.piAdapter = piAdapter;
  }

  selectedProfile(provider) {
    const profile = profileFor(this.profiles(), provider);
    return usesCompatibleWebSocket(profile)
      ? profileSnapshot(profile)
      : undefined;
  }

  providerInfo(provider) {
    return this.piAdapter.providerInfo(provider);
  }

  providerRetryPolicy(provider) {
    return this.piAdapter.providerRetryPolicy(provider);
  }

  imageRequestTarget(provider, model, image) {
    if (this.selectedProfile(provider) !== undefined) {
      return this.piAdapter.imageRequestTarget(provider, model, image);
    }
    return this.piAdapter.imageRequestTarget(provider, model, image);
  }

  listModels(provider) {
    return this.piAdapter.listModels(provider);
  }

  resolveModel(provider, model, signal) {
    return this.piAdapter.resolveModel(provider, model, signal);
  }

  async prepareCall(provider, model, signal) {
    const profile = this.selectedProfile(provider);
    if (profile === undefined)
      return this.piAdapter.prepareCall(provider, model, signal);
    const prepared = await this.piAdapter.prepareCall(provider, model, signal);
    return { model: prepared.model, stream: (options) => this.stream(options) };
  }

  stream(options) {
    const profile = this.selectedProfile(options.provider);
    return profile === undefined
      ? this.piAdapter.stream(options)
      : this.streamWithProfile(options, profile);
  }

  async *streamWithProfile(options, profile) {
    try {
      const apiKey = await resolveApiKey(
        this.ctx,
        this.piAdapter,
        options.provider,
        profile.apiKeyEnv,
      );
      const request = serializeResponsesRequest(options, {
        callIdMaxLength: CALL_ID_MAX_LENGTH,
      });
      const headers = await this.requestHeaders(options, profile);
      const events = streamWebSocketWithHandshakeRetries(streamWebSocket, {
        baseURL: profile.baseURL,
        apiKey,
        request,
        signal: options.signal,
        headers,
        connectTimeoutMs: profile.connectTimeoutMs,
      });
      yield* translateResponsesEvents(events);
    } catch (error) {
      throw normalizeError(error, options.signal);
    }
  }

  async requestHeaders(options, profile) {
    const prepare = this.piAdapter?.config?.prepareHeaders;
    try {
      const headers = new Headers(profile.headers);
      const request = Object.freeze({
        provider: options.provider,
        model: options.model,
        baseURL: profile.baseURL,
        ...(options.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
        ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      });
      const prepared = typeof prepare === "function"
        ? await prepare(request, headers)
        : await this.ctx.waterfall(
          "llm-pi-ai/request-headers",
          request,
          headers,
          () => headers,
        );
      const result = new Headers(prepared);
      for (const [name, value] of Object.entries(attributionHeaders())) {
        result.set(name, value);
      }
      return Object.fromEntries(result);
    } catch (cause) {
      throw new LlmError(
        `Responses WebSocket request header preparation failed for provider "${options.provider}"`,
        "REQUEST_HEADERS",
        { cause },
      );
    }
  }
}

/** Build the adapter used by the pi-ai registration interception. */
export function createResponsesWebSocketRouter(ctx, profiles, piAdapter) {
  return new ResponsesWebSocketRouter(ctx, profiles, piAdapter);
}
