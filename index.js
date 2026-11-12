import { createResponsesWebSocketRouter } from "./router.js";

const PI_AI_SETTINGS_NAMESPACE = "llm-pi-ai";

export const name = "llm-responses-websocket";
export const inject = ["llm"];

/**
 * Read the native pi-ai configuration through the settings seam. The bundle
 * owns no provider settings: the native adapter remains their sole owner.
 */
export function configuredPiAiProfiles(ctx) {
  try {
    const settings = ctx.get?.("settings");
    const descriptor = settings
      ?.describe?.()
      .find((candidate) => candidate.ns === PI_AI_SETTINGS_NAMESPACE);
    const providers = descriptor?.value?.providers;
    if (
      providers !== null &&
      typeof providers === "object" &&
      !Array.isArray(providers)
    ) {
      return providers;
    }
  } catch {
    // The Settings seam is optional outside the web profile. A missing or
    // unavailable descriptor leaves this call on its native transport.
  }
  return undefined;
}

/**
 * Read native resolved profiles when the host keeps its registered adapters
 * inspectable. This preserves catalog defaults; the settings representation is
 * the portable fallback for future hosts that do not expose this detail.
 */
export function resolvedPiAiProfiles(ctx, provider) {
  try {
    const registration = ctx.llm?.adapters?.get?.(provider);
    const adapter = registration?.adapter;
    if (typeof adapter?.current === "function") {
      const profiles = adapter.current()?.profiles;
      if (typeof profiles?.get === "function") return profiles;
    }
    if (typeof adapter?.config?.profiles === "function") {
      const profiles = adapter.config.profiles();
      if (typeof profiles?.get === "function") return profiles;
    }
  } catch {
    // The native adapter has no stable public resolved-profile accessor. Fall
    // back to the settings seam instead of blocking ordinary native routing.
  }
  return undefined;
}

function registeredAdapter(ctx, provider) {
  try {
    return ctx.llm?.adapters?.get?.(provider)?.adapter;
  } catch {
    return undefined;
  }
}

/**
 * Replace only dispatch for profiles that opt into the compatible Responses
 * WebSocket. The host resolves the adapter and model before this waterfall,
 * so every other route continues unchanged through `next()`.
 */
export function apply(ctx) {
  const routers = new WeakMap();
  return ctx.on("llm/stream", (options, next) => {
    const adapter = registeredAdapter(ctx, options.provider);
    const profiles = () =>
      resolvedPiAiProfiles(ctx, options.provider) ??
      configuredPiAiProfiles(ctx);
    if (profiles() === undefined) return next();

    let router =
      adapter !== null && typeof adapter === "object"
        ? routers.get(adapter)
        : undefined;
    if (router === undefined) {
      router = createResponsesWebSocketRouter(ctx, profiles, adapter);
      if (adapter !== null && typeof adapter === "object") {
        routers.set(adapter, router);
      }
    }
    const profile = router.selectedProfile(options.provider);
    return profile === undefined ? next() : router.streamWithProfile(options, profile);
  });
}

export {
  createResponsesWebSocketRouter,
  ResponsesWebSocketRouter,
  streamWebSocketWithHandshakeRetries,
  usesCompatibleWebSocket,
} from "./router.js";
