/**
 * Fake browser WebSocket for the agent and terminal channels.
 *
 *   const ws = installFakeWebSocket();
 *   client.connect();
 *   const socket = ws.last!;          // url, protocols, sent frames
 *   socket.serverOpen();
 *   socket.serverSend({ type: "system", subtype: "init" });
 *   socket.serverClose(4401, "token rejected");
 *   ws.restore();
 *
 * Nothing happens until the test drives it: sockets stay CONNECTING until
 * serverOpen(), and close() from the client only reports "onclose" once the
 * test calls serverClose() or flushClose().
 */

type Handler<E> = ((event: E) => void) | null;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: string[];
  readyState = FakeWebSocket.CONNECTING;
  protocol = "";
  /** Frames the client sent, raw. */
  readonly sent: string[] = [];
  /** Code and reason of the client's own close() call, if any. */
  clientClose: { code?: number; reason?: string } | null = null;

  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;
  onclose: Handler<CloseEvent> = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? [...protocols] : [protocols];
    registry.sockets.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`FakeWebSocket: send() while readyState=${this.readyState}`);
    }
    this.sent.push(data);
  }

  /** Sent frames parsed as JSON (non-JSON frames are skipped). */
  sentJson(): any[] {
    const out: any[] = [];
    for (const frame of this.sent) {
      try {
        out.push(JSON.parse(frame));
      } catch {
        /* raw terminal input */
      }
    }
    return out;
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.clientClose = { code, reason };
    this.readyState = FakeWebSocket.CLOSING;
  }

  // --- server side, driven by the test --------------------------------------

  serverOpen(protocol = this.protocols[0] ?? ""): void {
    this.protocol = protocol;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({ type: "open" } as Event);
  }

  serverSend(data: unknown): void {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.({ type: "message", data: text } as MessageEvent);
  }

  serverError(): void {
    this.onerror?.({ type: "error" } as Event);
  }

  serverClose(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ type: "close", code, reason, wasClean: code === 1000 } as CloseEvent);
  }

  /** Deliver the close the client asked for with close(). */
  flushClose(): void {
    if (this.readyState !== FakeWebSocket.CLOSING) return;
    this.serverClose(this.clientClose?.code ?? 1005, this.clientClose?.reason ?? "");
  }
}

const registry: { sockets: FakeWebSocket[] } = { sockets: [] };

export interface FakeWebSocketControl {
  /** Every socket constructed since install, oldest first. */
  readonly sockets: FakeWebSocket[];
  readonly last: FakeWebSocket | null;
  /** Sockets the client has not closed and the server has not closed. */
  live(): FakeWebSocket[];
  restore(): void;
}

/** Replace globalThis.WebSocket until restore(). */
export function installFakeWebSocket(): FakeWebSocketControl {
  const g = globalThis as { WebSocket?: unknown };
  const previous = g.WebSocket;
  registry.sockets = [];
  g.WebSocket = FakeWebSocket;
  return {
    get sockets() {
      return registry.sockets;
    },
    get last() {
      return registry.sockets.length ? registry.sockets[registry.sockets.length - 1] : null;
    },
    live() {
      return registry.sockets.filter((s) => s.readyState <= FakeWebSocket.OPEN);
    },
    restore() {
      g.WebSocket = previous;
    },
  };
}
