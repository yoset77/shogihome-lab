import { WebSocket, type RawData } from "ws";

export const RELAY_WINDOW_MS = 10_000;
export const MAX_RELAY_MESSAGES = 200;
export const MAX_RELAY_RECEIVED_BYTES = 8 * 1024 * 1024;
export const MAX_RELAY_BUFFERED_BYTES = 8 * 1024 * 1024;
const blockedSockets = new WeakSet<WebSocket>();

export const isRelaySocketOpen = (ws: WebSocket): boolean =>
  ws.readyState === WebSocket.OPEN && !blockedSockets.has(ws);

export function createRelayMessageLimiter(ws: WebSocket): (data: RawData | string) => boolean {
  let startedAt = performance.now();
  let messages = 0;
  let bytes = 0;
  return (data) => {
    if (!isRelaySocketOpen(ws)) return false;
    const now = performance.now();
    if (now - startedAt >= RELAY_WINDOW_MS) {
      startedAt = now;
      messages = 0;
      bytes = 0;
    }
    bytes += Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
      : typeof data === "string"
        ? Buffer.byteLength(data)
        : data.byteLength;
    if (++messages <= MAX_RELAY_MESSAGES && bytes <= MAX_RELAY_RECEIVED_BYTES) return true;

    blockedSockets.add(ws);
    // A peer need not finish the close handshake; bound resource retention too.
    const timer = setTimeout(() => ws.terminate(), 1000);
    timer.unref();
    ws.once("close", () => clearTimeout(timer));
    ws.close(1008, "Relay rate limit exceeded");
    return false;
  };
}

export function sendRelayFrame(ws: WebSocket, frame: string): boolean {
  if (!isRelaySocketOpen(ws)) return false;
  // Include the largest possible unmasked frame header in the budget.
  if (ws.bufferedAmount + Buffer.byteLength(frame) + 10 > MAX_RELAY_BUFFERED_BYTES) {
    blockedSockets.add(ws);
    ws.terminate();
    return false;
  }
  try {
    ws.send(frame);
    return true;
  } catch {
    blockedSockets.add(ws);
    ws.terminate();
    return false;
  }
}
