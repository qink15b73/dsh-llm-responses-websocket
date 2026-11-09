# Responses WebSocket transport for DSH

An optional [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
bundle that routes compatible OpenAI Responses providers over WebSocket.

> **Compatibility:** developed against DSH `0.2.2-rc.1`. DSH is pre-release
> software; validate this bundle against the DSH version you run.

## What it does

DSH's native **Settings > Models** provider list remains the sole source of
provider configuration. This bundle adds **Use compatible Responses WebSocket**
to OpenAI Responses-compatible provider cards.

When the bundle is enabled, its patch replaces DSH's `llm-pi-ai` adapter with a
router. The router sends a provider through WebSocket only when that provider
uses a compatible Responses protocol and its transport is set to `websocket`.
All other routes stay on the native pi-ai adapter.

The native adapter continues to own provider discovery, settings, credentials,
model metadata, request-header hooks, and ordinary HTTP/SSE requests.

## Install

Install into a DSH profile using its plugin manager:

```powershell
dsh plugin --profile desktop add github:qink15b73/dsh-llm-responses-websocket
```

Restart or reload DSH after installation. The bundle appears in the **Plugins**
list, where its switch controls whether the router layer is active:

- **Enabled:** compatible providers may use the Responses WebSocket transport.
- **Disabled:** DSH unloads the router layer and restores the native adapter.

## Configure a provider

1. In **Settings > Models**, add or select an OpenAI Responses-compatible
   provider.
2. Configure its endpoint, models, and credential using DSH's native controls.
3. Enable **Use compatible Responses WebSocket** on that provider card.
4. Select one of the provider's models and send a request.

This repository contains no provider endpoints, model IDs, credentials, or
Desktop-profile configuration. Keep those values in DSH settings or your own
credential management system.

## Behavior and limitations

- Only `openai-responses` and `openai-codex-responses` provider profiles with
  `transport: websocket` use this router.
- The WebSocket endpoint is derived from the provider base URL by appending
  `/responses` and converting `https`/`http` to `wss`/`ws`.
- Only failures before a request frame is sent are retried. A request is never
  replayed after it might have reached the provider.
- Outbound function `call_id` values longer than 64 characters are
  deterministically shortened, preserving call/result correlation for gateways
  with that limit.
- This is a third-party bundle, not an official DeepSeek project and not
  affiliated with DeepSeek.

## Development

Requires Node.js 24 or later and the peer DSH packages matching the supported
DSH version.

```powershell
npm install
npm test
npm run check
npm pack --dry-run
```

`npm pack --dry-run` deliberately excludes the test suite and development
dependencies from the package tarball.

## License

[MIT](LICENSE)
