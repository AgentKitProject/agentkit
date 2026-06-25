/**
 * Chunk-boundary-safe Server-Sent Events (SSE) parsing for the hosted Gateway.
 *
 * The gateway turn/tool-result routes stream `text/event-stream` bodies. A
 * single network chunk may split an event mid-line, and multiple events may
 * arrive in one chunk. This parser buffers across chunks and only emits a
 * complete event once its terminating blank line is seen.
 *
 * We parse the minimal SSE subset the gateway uses: `data:` lines whose payload
 * is a JSON object. `event:`/`id:`/`retry:` fields and comments (`:` lines) are
 * tolerated and ignored. Multiple `data:` lines in one event are concatenated
 * with `\n`, per the SSE spec.
 */

/** A normalized gateway stream event (the JSON parsed out of a `data:` line). */
export type GatewayStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: unknown }
  | { type: "usage"; [key: string]: unknown }
  | { type: "done"; stopReason: string }
  | { type: "error"; message?: string; code?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

/**
 * Incremental SSE parser. Feed it decoded text via {@link push}; it returns the
 * complete JSON event objects that became available. Call {@link flush} once the
 * stream ends to drain a trailing event with no terminating blank line.
 */
export class SseParser {
  private buffer = "";

  /** Feed a decoded text chunk; returns any newly-complete events. */
  push(chunk: string): GatewayStreamEvent[] {
    this.buffer += chunk;
    const events: GatewayStreamEvent[] = [];
    // Normalize CRLF to LF so blank-line detection is uniform.
    let sep = this.findEventBoundary();
    while (sep !== -1) {
      const rawEvent = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      const parsed = parseEventBlock(rawEvent);
      if (parsed !== undefined) events.push(parsed);
      sep = this.findEventBoundary();
    }
    return events;
  }

  /** Drain a final event that wasn't terminated by a blank line. */
  flush(): GatewayStreamEvent[] {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining.length === 0) return [];
    const parsed = parseEventBlock(remaining);
    return parsed === undefined ? [] : [parsed];
  }

  /** Find the next event boundary (blank line). Supports `\n\n` and `\r\n\r\n`. */
  private findEventBoundary(): { index: number; length: number } | -1 {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return -1;
    if (crlf === -1) return { index: lf, length: 2 };
    if (lf === -1) return { index: crlf, length: 4 };
    return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
  }
}

/**
 * Parse one SSE event block (the text between blank lines) into a JSON object.
 * Returns `undefined` for comment-only or non-JSON-data blocks.
 */
function parseEventBlock(block: string): GatewayStreamEvent | undefined {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine;
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    // Per spec, a single leading space after the colon is stripped.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join("\n").trim();
  if (payload.length === 0 || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as GatewayStreamEvent;
  } catch {
    // A `data:` line that isn't JSON is ignored rather than crashing the loop.
    return undefined;
  }
}
