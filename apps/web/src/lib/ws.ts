"use client";

import { parseServerMessage, type ServerMessage } from "@liveread/shared";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface ReconnectingSocketOptions {
  url: string;
  onMessage: (msg: ServerMessage) => void;
  onState?: (state: ConnectionState) => void;
  /** called on every (re)connect so callers can (re)subscribe */
  onOpen?: (socket: WebSocket) => void;
  maxBackoffMs?: number;
}

/**
 * Reconnecting WebSocket with exponential backoff and jitter.
 * Malformed server messages are dropped (schema-validated).
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.opts.onState?.(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.opts.onState?.("open");
      this.opts.onOpen?.(ws);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg) this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) {
        this.opts.onState?.("closed");
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here
    };
  }

  private scheduleReconnect(): void {
    this.attempts++;
    const base = Math.min(
      this.opts.maxBackoffMs ?? 15_000,
      500 * Math.pow(2, this.attempts),
    );
    const jitter = base * (0.5 + Math.random() * 0.5);
    this.opts.onState?.("reconnecting");
    this.reconnectTimer = setTimeout(() => this.open(), jitter);
  }

  send(data: string): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.opts.onState?.("closed");
  }
}
