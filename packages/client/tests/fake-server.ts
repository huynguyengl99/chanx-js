import type { AddressInfo } from 'node:net';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { ENVELOPE_VERSION } from '../src/core/protocol';

interface Frame extends Record<string, unknown> {
  action?: string;
  topic?: string;
  ref?: string;
}

/**
 * A minimal stand-in for a chanx server, speaking the real envelope over a real socket.
 *
 * It mirrors chanx (2.11.2+) where the client depends on it, including the limits: a
 * reply echoes the request's `ref` whether or not it was topic-addressed, but a plain
 * frame sent without one gets a reply with no envelope at all; and `ping` is answered
 * only when the consumer declares a handler, since chanx has no built-in one. A fake
 * that is kinder than the server hides client bugs.
 */
export class FakeServer {
  private readonly wss: WebSocketServer;
  readonly received: Frame[] = [];
  readonly sockets = new Set<WebSocket>();
  connections = 0;

  private constructor(
    wss: WebSocketServer,
    private readonly handlesPing: boolean,
  ) {
    this.wss = wss;
    wss.on('connection', (socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (raw: Buffer) => this.handle(socket, raw));
    });
  }

  static async start(options: { handlesPing?: boolean } = {}): Promise<FakeServer> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    return new FakeServer(wss, options.handlesPing ?? true);
  }

  get url(): string {
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  private handle(socket: WebSocket, raw: Buffer): void {
    const frame = JSON.parse(raw.toString()) as Frame;
    this.received.push(frame);

    const reply = (body: Record<string, unknown>) => {
      const envelope: Record<string, unknown> = {};
      if (frame.topic !== undefined) envelope.topic = frame.topic;
      if (frame.ref !== undefined) envelope.ref = frame.ref;
      // A plain frame without a ref gets a bare reply, exactly as chanx sends it.
      const out = Object.keys(envelope).length
        ? { ...body, version: ENVELOPE_VERSION, ...envelope }
        : body;
      socket.send(JSON.stringify(out));
    };

    switch (frame.action) {
      case 'subscribe':
        reply({ action: 'subscribed', payload: null });
        break;
      case 'unsubscribe':
        reply({ action: 'unsubscribed', payload: null });
        break;
      case 'ping':
        if (this.handlesPing) reply({ action: 'pong', payload: null });
        else reply({ action: 'error', payload: [{ msg: 'unknown action ping' }] });
        break;
      case 'post':
        reply({ action: 'posted', payload: frame.payload });
        break;
      default:
        reply({ action: 'error', payload: { detail: `unknown action ${frame.action}` } });
    }
  }

  /** Push an unsolicited frame, as a broadcast would. */
  push(body: Record<string, unknown>): void {
    const data = JSON.stringify({ version: ENVELOPE_VERSION, ...body });
    for (const socket of this.sockets) socket.send(data);
  }

  /** Drop every client socket without closing the server, to force a reconnect. */
  dropClients(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
