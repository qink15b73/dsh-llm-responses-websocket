# Responses WebSocket transport for DSH

An optional [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
bundle that routes compatible OpenAI Responses providers over WebSocket.

> **Compatibility:** supports DSH `>=0.2.2-0 <0.3.0-0`; validated against
> Desktop `0.2.2-rc.2`. DSH is pre-release software, so validate this bundle
> against the DSH version you run. DSH `0.3.0` and later require a new
> compatibility check before use.

## What it does

DSH's native **Settings > Models** provider list remains the sole source of
provider configuration. This bundle adds **Use compatible Responses WebSocket**
to OpenAI Responses-compatible provider cards.

When the bundle is enabled, it adds an `llm/stream` middleware beside DSH's
native `llm-pi-ai` adapter. The middleware sends a provider through WebSocket
only when that provider uses a compatible Responses protocol and its transport
is set to `websocket`. All other routes continue through native pi-ai dispatch.

The native adapter continues to own provider discovery, settings, credentials,
model metadata, request-header hooks, and ordinary HTTP/SSE requests.

The bundle declares the native adapter as a peer dependency and does not embed
or pin a second copy of DSH's `llm-pi-ai` adapter. It reads the native settings
namespace and uses DSH's stream middleware seam, which remains compatible with
the stricter patch-name validation introduced in Desktop `0.2.2-rc.2`.

## Install

Install into a DSH profile using its plugin manager:

```powershell
dsh plugin --profile desktop add github:qink15b73/dsh-llm-responses-websocket
```

Restart or reload DSH after installation. The bundle appears in the **Plugins**
list, where its switch controls whether the router layer is active:

- **Enabled:** compatible providers may use the Responses WebSocket transport.
- **Disabled:** DSH unloads the router layer and restores the native adapter.

### Upgrading from an earlier bundle release

Update or reinstall the bundle when upgrading DSH, rather than granting a
version-compatibility override to an older release. Earlier bundle releases
replaced the native `llm-pi-ai` entry; DSH Desktop `0.2.2-rc.2` rejects that
patch shape and it can leave native provider cards unavailable. The current
bundle is a separate stream-middleware entry, so existing provider settings in
**Settings > Models** remain owned and displayed by native DSH.

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
