import {
  Config as PiAiConfig,
  PiAiAdapter,
  apply as applyPiAi,
} from "@deepseek-ai/dsh-llm-pi-ai-native";
import { createResponsesWebSocketRouter } from "./router.js";

export const name = "llm-pi-ai";
export const inject = ["llm"];
export const Config = PiAiConfig;

/**
 * Intercept only registrations made by the native pi-ai adapter. The native
 * adapter can remain dormant until a provider is added from Settings, so this
 * stays installed for the lifetime of this bundle rather than wrapping only
 * the synchronous initial registration.
 */
export function interceptPiAiRegistration(ctx, profiles) {
  const originalRegisterAdapter = ctx.llm.registerAdapter;
  const routers = new WeakMap();
  const registerAdapter = (providers, adapter) => {
    if (!(adapter instanceof PiAiAdapter)) {
      return Reflect.apply(originalRegisterAdapter, ctx.llm, [
        providers,
        adapter,
      ]);
    }
    let router = routers.get(adapter);
    if (router === undefined) {
      router = createResponsesWebSocketRouter(ctx, profiles, adapter);
      routers.set(adapter, router);
    }
    return Reflect.apply(originalRegisterAdapter, ctx.llm, [providers, router]);
  };
  ctx.llm.registerAdapter = registerAdapter;
  return () => {
    if (ctx.llm.registerAdapter === registerAdapter) {
      ctx.llm.registerAdapter = originalRegisterAdapter;
    }
  };
}

/**
 * Run the native provider adapter unchanged, replacing only the adapter it
 * registers with a per-provider transport router.
 */
export function apply(ctx, config) {
  const restoreRegistration = interceptPiAiRegistration(ctx, () =>
    config.providers.get(),
  );
  try {
    applyPiAi(ctx, config);
  } catch (error) {
    restoreRegistration();
    throw error;
  }
  ctx.effect(
    () => () => restoreRegistration(),
    "responses-websocket: restore adapter registration",
  );
}

export {
  createResponsesWebSocketRouter,
  ResponsesWebSocketRouter,
  streamWebSocketWithHandshakeRetries,
  usesCompatibleWebSocket,
} from "./router.js";
