import WebSocket from "ws";
import { ResponsesProtocolError } from "./parser.js";

function websocketURL(baseURL, explicitURL = undefined) {
  if (typeof explicitURL === "string" && explicitURL.length > 0)
    return new URL(explicitURL).href;
  const url = new URL(baseURL);
  url.protocol =
    url.protocol === "https:"
      ? "wss:"
      : url.protocol === "http:"
        ? "ws:"
        : url.protocol;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function responsesURL(baseURL) {
  const url = new URL(baseURL);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function headers(apiKey, additional) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...additional,
  };
}

export class ResponsesTransportError extends ResponsesProtocolError {
  constructor(message, code = "TRANSPORT", options = undefined) {
    super(message, code, options);
    this.name = "ResponsesTransportError";
    this.safeToFallback = options?.safeToFallback === true;
  }
}

function errorFromEvent(event) {
  const error =
    event?.error && typeof event.error === "object" ? event.error : event;
  const message =
    typeof error?.message === "string"
      ? error.message
      : "Responses endpoint returned an error event";
  const code = typeof error?.code === "string" ? error.code : "PROVIDER_ERROR";
  return new ResponsesProtocolError(message, code);
}

/** Parse an event-stream Response body into JSON Responses events. */
export async function* parseSseEvents(body, signal) {
  if (!body)
    throw new ResponsesProtocolError(
      "Responses SSE response has no body",
      "EMPTY_RESPONSE",
    );
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      signal?.throwIfAborted?.();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value.replaceAll("\r\n", "\n");
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch (cause) {
          throw new ResponsesProtocolError(
            "Responses SSE frame is not JSON",
            "MALFORMED_RESPONSE",
            { cause },
          );
        }
        if (event?.type === "error") throw errorFromEvent(event);
        yield event;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

/** Connect, send exactly one request frame, and yield JSON provider events. */
export async function* streamWebSocket({
  baseURL,
  wsURL,
  apiKey,
  request,
  signal,
  headers: additionalHeaders,
  connectTimeoutMs = 15_000,
}) {
  const url = websocketURL(baseURL, wsURL);
  let socket;
  try {
    socket = new WebSocket(url, {
      headers: headers(apiKey, additionalHeaders),
      handshakeTimeout: connectTimeoutMs,
    });
  } catch (cause) {
    throw new ResponsesTransportError(
      "Responses WebSocket could not be created",
      "TRANSPORT",
      { cause, safeToFallback: true },
    );
  }
  const queue = [];
  let ended = false;
  let failure = undefined;
  let wake = undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const abort = () => {
    failure ??= new ResponsesProtocolError(
      "Responses request aborted",
      "ABORTED",
    );
    try {
      socket.close(1000, "request aborted");
    } catch {}
    notify();
  };
  signal?.addEventListener("abort", abort, { once: true });
  socket.on("message", (data, binary) => {
    if (binary) {
      failure ??= new ResponsesProtocolError(
        "Responses endpoint sent an unexpected binary WebSocket frame",
      );
    } else {
      try {
        queue.push(JSON.parse(data.toString("utf8")));
      } catch {
        failure ??= new ResponsesProtocolError(
          "Responses WebSocket frame is not JSON",
        );
      }
    }
    notify();
  });
  socket.on("error", (error) => {
    failure ??= new ResponsesProtocolError(
      error.message || "Responses WebSocket transport failed",
      "TRANSPORT",
    );
    notify();
  });
  socket.on("close", () => {
    ended = true;
    notify();
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new ResponsesTransportError(
              `Responses WebSocket connect timed out after ${connectTimeoutMs}ms`,
              "TIMEOUT",
              { safeToFallback: true },
            ),
          ),
        connectTimeoutMs,
      );
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(
          new ResponsesTransportError(
            error.message || "Responses WebSocket handshake failed",
            "TRANSPORT",
            { cause: error, safeToFallback: true },
          ),
        );
      });
      socket.once("close", () => {
        clearTimeout(timeout);
        reject(
          new ResponsesTransportError(
            "Responses WebSocket closed during handshake",
            "TRANSPORT",
            { safeToFallback: true },
          ),
        );
      });
    });
    try {
      socket.send(JSON.stringify(request));
    } catch (cause) {
      throw new ResponsesTransportError(
        "Responses WebSocket could not send request",
        "TRANSPORT",
        { cause, safeToFallback: false },
      );
    }
    while (true) {
      signal?.throwIfAborted?.();
      while (queue.length > 0) yield queue.shift();
      if (failure) throw failure;
      if (ended) return;
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      socket.close(1000, "stream complete");
    } catch {}
  }
}

export async function streamSse({
  baseURL,
  apiKey,
  request,
  signal,
  headers: additionalHeaders,
  fetchImpl = fetch,
}) {
  const { type: _type, ...payload } = request;
  let response;
  try {
    response = await fetchImpl(responsesURL(baseURL), {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        ...headers(apiKey, additionalHeaders),
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    if (signal?.aborted)
      throw new ResponsesProtocolError(
        "Responses SSE request aborted",
        "ABORTED",
      );
    throw new ResponsesProtocolError(
      "Responses SSE transport failed",
      "TRANSPORT",
      { cause },
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ResponsesProtocolError(
      `Responses SSE request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 400)}` : ""}`,
      `HTTP_${response.status}`,
    );
  }
  return parseSseEvents(response.body, signal);
}

export { responsesURL, websocketURL };
