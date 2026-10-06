import type { ClientMsg, ServerMsg } from "../core/protocol";

const SESSION_KEY = "rb.session";

export interface Session { code: string; token: string }

export function loadSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null"); } catch { return null; }
}
export function saveSession(s: Session | null): void {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

/** WebSocket wrapper that reconnects with the saved session token (phones drop sockets constantly). */
export class Net {
  private ws: WebSocket | null = null;
  private queue: ClientMsg[] = [];
  private retry = 0;
  private wantOpen = false;
  onmsg: (m: ServerMsg) => void = () => {};
  onstatus: (online: boolean) => void = () => {};
  /** called after a reconnect so the caller can resume the saved session */
  onreconnect: () => void = () => {};

  private url(): string {
    const u = new URL("ws", location.href);
    u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  connect(): void {
    this.wantOpen = true;
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      const reconnect = this.retry > 0;
      this.retry = 0;
      this.onstatus(true);
      if (reconnect) this.onreconnect();
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (e) => {
      try { this.onmsg(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      this.onstatus(false);
      if (!this.wantOpen) return;
      this.retry++;
      setTimeout(() => this.connect(), Math.min(5000, 400 * this.retry));
    };
  }

  close(): void {
    this.wantOpen = false;
    this.ws?.close();
    this.ws = null;
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
    else { this.queue.push(m); this.connect(); }
  }
}
