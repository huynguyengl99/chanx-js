import type { WebSocketLike } from '../src/core/socket';

/** A WebSocket stand-in that lets a test drive open/message/close by hand. */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  sent: Array<Record<string, unknown>> = [];

  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('No socket was created');
    return socket;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The last frame sent, which is what most assertions care about. */
  get lastSent(): Record<string, unknown> {
    const frame = this.sent.at(-1);
    if (!frame) throw new Error('Nothing was sent');
    return frame;
  }
}

export const fakeFactory = (url: string): WebSocketLike => new FakeSocket(url);
