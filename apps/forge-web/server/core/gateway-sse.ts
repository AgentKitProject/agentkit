// SSE transport adapter for the gateway streaming routes (Gateway Phase 2b).
//
// gateway-core's router is transport-agnostic: it pushes normalized StreamEvents
// through a host-provided SseEmitter and resolves a GatewayResponse describing
// whether the host should have produced a `json` body or a `stream`. This module
// bridges that to the Next.js App Router using a ReadableStream + TextEncoder.
//
// Wire format: standard `text/event-stream`. Each StreamEvent is serialized as a
// single SSE `data:` line carrying the event JSON, e.g.
//
//   data: {"type":"text","delta":"Hello"}\n\n
//   data: {"type":"usage","input":12,"output":3,"cached":0}\n\n
//   data: {"type":"done","stopReason":"end_turn"}\n\n
//
// The client (WebForgeClient.runAgentKitWithAi) parses these back into events.
import type { GatewayResponse, SseEmitter, StreamEvent } from "@agentkitforge/gateway-core";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Disable proxy buffering (nginx / Amplify edge) so deltas flush promptly.
  "x-accel-buffering": "no"
} as const;

/** Serializes one StreamEvent to an SSE `data:` frame. */
export function encodeSseEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * A canned single-turn SSE response (text + done) with NO provider call and NO
 * credit hold. Used by the protected-kit leakage guard to refuse an obvious
 * prompt-extraction attempt without billing the buyer or invoking the model.
 */
export function refusalSseResponse(message: string): Response {
  const encoder = new TextEncoder();
  const frames = [
    encodeSseEvent({ type: "text", delta: message }),
    encodeSseEvent({ type: "done", stopReason: "end_turn" })
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/**
 * Runs a gateway router call that may stream, and returns the appropriate
 * Next.js Response:
 *   - For a `json` GatewayResponse (create / delete / pre-stream error such as
 *     402 insufficient-credits) → a JSON Response with the router's status.
 *   - For a `stream` GatewayResponse → a `text/event-stream` Response whose body
 *     is driven by the router via the emitter we inject.
 *
 * The router drives the emitter to completion synchronously within `run`, so we
 * collect events into the ReadableStream and close it when the router resolves.
 */
export async function streamGatewayResponse(
  run: (createEmitter: () => SseEmitter) => Promise<GatewayResponse>
): Promise<Response> {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Buffer events that arrive before the ReadableStream `start` runs (the router
  // is invoked lazily inside start(), so in practice events arrive after the
  // controller exists — but we guard against ordering surprises).
  const pending: string[] = [];
  let closed = false;

  const emit = (event: StreamEvent) => {
    const frame = encodeSseEvent(event);
    if (controllerRef && !closed) {
      controllerRef.enqueue(encoder.encode(frame));
    } else {
      pending.push(frame);
    }
  };

  const createEmitter = (): SseEmitter => ({
    emit,
    close: () => {
      /* the ReadableStream is closed when `run` resolves; no-op here */
    }
  });

  // We must know whether the router produced a json or stream response BEFORE we
  // commit to SSE headers. So drive the router first; if it returned `json`,
  // return a plain JSON Response. If `stream`, we've already buffered the events
  // and replay them through a ReadableStream that closes immediately.
  let response: GatewayResponse;
  try {
    response = await run(() => ({
      emit: (event) => pending.push(encodeSseEvent(event)),
      close: () => {}
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }

  if (response.kind === "json") {
    const json = (response as { body: unknown }).body;
    // 204 No Content must not carry a body.
    if (response.status === 204) return new Response(null, { status: 204 });
    return Response.json(json ?? {}, { status: response.status });
  }

  // Streaming: replay the buffered SSE frames. (gateway-core drives the whole
  // turn to completion synchronously before `run` resolves, so all frames are
  // already buffered — we stream them out and close.)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const frame of pending) controller.enqueue(encoder.encode(frame));
      closed = true;
      controller.close();
    }
  });
  return new Response(body, { status: response.status, headers: SSE_HEADERS });
}
