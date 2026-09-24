import type { RawFrame } from './protocol';
import { ENVELOPE_VERSION } from './protocol';
import { safely } from './report';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The slice of the WebSocket API the runtime uses, so tests can substitute a fake. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;

export interface HeartbeatOptions {
  /** Milliseconds between pings. */
  interval?: number;
  /** Close and reconnect if nothing arrives within this long after a ping. */
  timeout?: number;
  /** Frame to send. Defaults to chanx's own `{ action: 'ping' }`. */
  message?: () => object;
}

export interface SocketOptions {
  protocols?: string | string[];
  queryParams?: Record<string, string | number>;
  /**
   * Share one socket per resolved URL. `connect()` defaults it to true for channels that
   * carry topics and false otherwise: topic frames are routed per consumer, but on a
   * plain channel every consumer of a shared socket sees every reply.
   */
  share?: boolean;
  shouldReconnect?: (event: { code?: number; reason?: string }) => boolean;
  reconnectAttempts?: number;
  /** Fixed delay, or a function of the attempt number for backoff. */
  reconnectInterval?: number | ((attempt: number) => number);
  retryOnError?: boolean;
  onReconnectStop?: (attempts: number) => void;
  /**
   * Ping on an interval and reconnect if nothing comes back. Off unless enabled: chanx
   * consumers only answer `ping` when they declare a handler for it, and one that does
   * not replies with an `error` frame every interval. `connect()` turns it on for
   * channels whose schema declares ping/pong.
   */
  heartbeat?: false | HeartbeatOptions;
  /** Cap on frames buffered while the socket is not yet open. */
  maxQueuedFrames?: number;
  socketFactory?: SocketFactory;
  /**
   * Grace period before a socket with no remaining consumers is actually closed.
   * React's StrictMode unmounts and immediately remounts in development, which would
   * otherwise tear down and rebuild the connection on every mount.
   */
  closeDelay?: number;
}

type FrameListener = (frame: RawFrame) => void;
type StatusListener = (status: SocketStatus) => void;
type OpenListener = () => void;
type RawListener = (data: unknown) => void;
type TerminateListener = () => void;

const DEFAULTS = {
  reconnectAttempts: 10,
  reconnectInterval: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
  maxQueuedFrames: 100,
  closeDelay: 100,
  heartbeatInterval: 25_000,
  heartbeatTimeout: 10_000,
};

function defaultFactory(url: string, protocols?: string | string[]): WebSocketLike {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'No global WebSocket. Pass `socketFactory` when running outside a browser.',
    );
  }
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

/**
 * One WebSocket, shared by every consumer that resolved the same URL.
 *
 * Owns reconnection, the heartbeat and the pre-open send queue. It knows nothing about
 * channels or topics; it moves frames and reports status.
 */
export class SharedSocket {
  readonly url: string;
  status: SocketStatus = 'connecting';

  private socket: WebSocketLike | null = null;
  private refs = 0;
  private attempt = 0;
  private closedByUs = false;
  private queue: string[] = [];
  /** Subscribed handles per topic, across every connection sharing this socket. */
  private readonly topicClaims = new Map<string, number>();

  private readonly frameListeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly openListeners = new Set<OpenListener>();
  private readonly rawListeners = new Set<RawListener>();
  private readonly terminateListeners = new Set<TerminateListener>();
  private disposed = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    url: string,
    private readonly options: SocketOptions,
    private readonly onDispose: () => void,
  ) {
    this.url = url;
  }

  retain(): void {
    this.refs += 1;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    // Only a socket that gave up reopens: one waiting to reconnect already has a timer,
    // and opening now as well would leave two WebSockets feeding this one.
    if (this.status === 'closed' && !this.disposed) {
      this.attempt = 0;
      this.open();
    }
  }

  release(): void {
    // A terminated socket has no claims left to give up.
    if (this.disposed || this.refs === 0) return;
    this.refs -= 1;
    if (this.refs > 0) return;
    const delay = this.options.closeDelay ?? DEFAULTS.closeDelay;
    this.closeTimer = setTimeout(() => {
      if (this.refs === 0) this.destroy();
    }, delay);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fires on every open, including reconnects, which is where topics resubscribe. */
  onOpen(listener: OpenListener): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /**
   * Fires when the socket is torn down for good: `terminate()`, or the last consumer
   * leaving. Connections still attached at that point were cut off by a terminate.
   */
  onTerminate(listener: TerminateListener): () => void {
    this.terminateListeners.add(listener);
    return () => this.terminateListeners.delete(listener);
  }

  /**
   * Close the socket for every consumer at once, regardless of how many still hold it.
   *
   * It does not reconnect, and it leaves the registry so the next `connect()` to this
   * URL opens a fresh socket. Consumers still attached see `closed`, have pending
   * requests rejected and open streams ended.
   */
  terminate(code = 1000, reason = ''): void {
    this.destroy(code, reason);
  }

  /** Non-JSON payloads, which chanx never sends but a proxy might. */
  onRaw(listener: RawListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  /** Record that one more handle on this socket holds a subscription to `topic`. */
  claimTopic(topic: string): void {
    this.topicClaims.set(topic, (this.topicClaims.get(topic) ?? 0) + 1);
  }

  /**
   * Drop one claim. Returns true when it was the last, meaning the server should be
   * told to unsubscribe. The server tracks subscriptions per socket, so an earlier
   * unsubscribe would cut off every other consumer of the topic too.
   */
  releaseTopic(topic: string): boolean {
    const claims = (this.topicClaims.get(topic) ?? 0) - 1;
    if (claims > 0) {
      this.topicClaims.set(topic, claims);
      return false;
    }
    this.topicClaims.delete(topic);
    return true;
  }

  send(frame: object): void {
    // Queueing would only hold the frame until garbage collection.
    if (this.disposed) return;
    const data = JSON.stringify(frame);
    if (this.socket && this.status === 'open') {
      this.socket.send(data);
      return;
    }
    const max = this.options.maxQueuedFrames ?? DEFAULTS.maxQueuedFrames;
    if (this.queue.length >= max) this.queue.shift();
    this.queue.push(data);
  }

  open(): void {
    if (this.disposed) return;
    this.closedByUs = false;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const factory = this.options.socketFactory ?? defaultFactory;
    let socket: WebSocketLike;
    try {
      socket = factory(this.url, this.options.protocols);
    } catch {
      this.scheduleReconnect({ code: 1006, reason: 'factory threw' });
      return;
    }
    this.socket = socket;
    // Events from a WebSocket this one has replaced must not touch its state.
    const current = () => this.socket === socket;

    socket.onopen = () => {
      if (!current()) return;
      this.attempt = 0;
      this.setStatus('open');
      this.startHeartbeat();
      for (const listener of [...this.openListeners]) safely(listener, undefined);
      const pending = this.queue;
      this.queue = [];
      for (const data of pending) socket.send(data);
    };

    socket.onmessage = (event) => {
      if (!current()) return;
      this.noteLiveness();
      if (typeof event.data !== 'string') {
        for (const listener of [...this.rawListeners]) safely(listener, event.data);
        return;
      }
      let frame: RawFrame;
      try {
        frame = JSON.parse(event.data) as RawFrame;
      } catch {
        for (const listener of [...this.rawListeners]) safely(listener, event.data);
        return;
      }
      for (const listener of [...this.frameListeners]) safely(listener, frame);
    };

    socket.onerror = () => {
      if (current() && this.options.retryOnError) socket.close();
    };

    socket.onclose = (event) => {
      if (!current()) return;
      this.stopHeartbeat();
      this.socket = null;
      if (this.closedByUs) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect(event);
    };
  }

  private scheduleReconnect(event: { code?: number; reason?: string }): void {
    const shouldReconnect = this.options.shouldReconnect ?? (() => true);
    const max = this.options.reconnectAttempts ?? DEFAULTS.reconnectAttempts;

    if (this.refs === 0 || !shouldReconnect(event)) {
      this.setStatus('closed');
      return;
    }
    if (this.attempt >= max) {
      this.setStatus('closed');
      this.options.onReconnectStop?.(this.attempt);
      return;
    }

    const interval = this.options.reconnectInterval ?? DEFAULTS.reconnectInterval;
    const delay = typeof interval === 'function' ? interval(this.attempt) : interval;
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startHeartbeat(): void {
    const settings = this.options.heartbeat;
    if (!settings) return;
    const interval = settings.interval ?? DEFAULTS.heartbeatInterval;
    const build = settings.message ?? (() => ({ action: 'ping', payload: null }));

    this.heartbeatTimer = setInterval(() => {
      this.send({ version: ENVELOPE_VERSION, ...build() });
      // Counted from the first unanswered ping: re-arming on every ping would push the
      // deadline back forever whenever the timeout is longer than the interval.
      if (!this.livenessTimer) {
        this.armLiveness(settings.timeout ?? DEFAULTS.heartbeatTimeout);
      }
    }, interval);
  }

  /** Any inbound frame proves the connection is alive, not just a pong. */
  private noteLiveness(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private armLiveness(timeout: number): void {
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      this.socket?.close(4000, 'heartbeat timeout');
    }, timeout);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.heartbeatTimer = null;
    this.livenessTimer = null;
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) safely(listener, status);
  }

  private destroy(code = 1000, reason = ''): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closedByUs = true;
    this.refs = 0;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.reconnectTimer = null;
    this.closeTimer = null;
    this.socket?.close(code, reason);
    this.socket = null;
    this.queue = [];
    this.topicClaims.clear();
    this.setStatus('closed');
    for (const listener of [...this.terminateListeners]) safely(listener, undefined);
    this.terminateListeners.clear();
    this.frameListeners.clear();
    this.statusListeners.clear();
    this.openListeners.clear();
    this.rawListeners.clear();
    this.onDispose();
  }
}

/**
 * Shared sockets, the same model as react-use-websocket's `sharedWebSockets`.
 * Module-global on purpose: two components asking for the same channel must land on
 * one connection.
 */
const registry = new Map<string, SharedSocket>();

let keyCounter = 0;
const factoryIds = new WeakMap<SocketFactory, number>();

/**
 * What makes two connections interchangeable: the URL, and what the socket is opened
 * with. Subprotocols often carry credentials, so a connection must never join a socket
 * opened under different ones.
 */
function registryKey(url: string, options: SocketOptions): string {
  keyCounter += 1;
  if (options.share === false) return `private:${keyCounter}`;
  let factoryId = 0;
  if (options.socketFactory) {
    factoryId = factoryIds.get(options.socketFactory) ?? keyCounter;
    factoryIds.set(options.socketFactory, factoryId);
  }
  return JSON.stringify([url, options.protocols ?? null, factoryId]);
}

export function acquireSocket(url: string, options: SocketOptions): SharedSocket {
  const key = registryKey(url, options);
  let socket = registry.get(key);
  if (!socket) {
    const created: SharedSocket = new SharedSocket(url, options, () => {
      // A terminated socket's key may already belong to its replacement.
      if (registry.get(key) === created) registry.delete(key);
    });
    socket = created;
    registry.set(key, socket);
    socket.retain();
    socket.open();
    return socket;
  }
  socket.retain();
  return socket;
}

/**
 * Close every socket in the process, whichever client opened it: on logout, say, when
 * nothing should stay connected. Prefer `client.closeAll()` to close only one client's.
 */
export function terminateAllSockets(code = 1000, reason = ''): void {
  for (const socket of [...registry.values()]) socket.terminate(code, reason);
}

/** Test helper: drop every shared socket. */
export function resetSockets(): void {
  registry.clear();
}
