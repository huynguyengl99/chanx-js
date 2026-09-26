import type { ChannelDescriptor, TopicRef, Validator } from './descriptor';
import { ActionEmitter } from './emitter';
import type { ChanxErrorFrame, ChanxMessage, Envelope, RawFrame } from './protocol';
import {
  COMPLETE_ACTIONS,
  envelopeOf,
  ERROR_ACTION,
  isFrameworkAction,
  stripEnvelope,
  withEnvelope,
} from './protocol';
import type { SharedSocket, SocketStatus } from './socket';
import type { MessageStream, StreamOptions } from './stream';
import { firstMessage, trackStream } from './stream';
import { reportError, safely } from './report';
import type { TopicHost } from './topic';
import { TopicHandle } from './topic';

export interface ValidateConfig {
  /** Validate messages before sending. Cheap, and catches real bugs. Default true. */
  outbound?: boolean;
  /** Validate every inbound frame. Costly on hot streams. Default: dev only. */
  inbound?: boolean;
}

export interface RequestOptions {
  timeout?: number;
}

const DEFAULT_REQUEST_TIMEOUT = 10_000;

/**
 * Connections sharing a socket must not share ref numbers, or one consumer's reply would
 * resolve another's request. Each connection prefixes its refs with its own id.
 */
let connectionCounter = 0;

interface TopicEntry {
  handle: TopicHandle<any, any>;
  refs: number;
}

/**
 * A typed channel riding a shared socket.
 *
 * Routes each inbound frame exactly once: a pending request claims it by `ref`, else a
 * topic claims it by `topic`, else it belongs to the channel itself. Framework frames
 * (`complete`, `subscribed`, `error`) are absorbed here so they never reach user code.
 */
export class ChannelConnection<
  ToServer extends ChanxMessage = ChanxMessage,
  ToClient extends ChanxMessage = ChanxMessage,
> implements TopicHost {
  private readonly emitter = new ActionEmitter<ToClient>();
  private readonly errorHandlers = new Set<(error: ChanxErrorFrame) => void>();
  private readonly completeHandlers = new Set<(message: ChanxMessage) => void>();
  private readonly topics = new Map<string, TopicEntry>();
  private readonly pending = new Map<
    string,
    {
      resolve: (m: ChanxMessage) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly unsubscribers: Array<() => void> = [];
  private readonly streams = new Set<MessageStream<ToClient>>();
  private readonly validateInbound: Validator<ToClient> | undefined;
  private readonly validateOutbound: Validator<ToServer> | undefined;
  private readonly refPrefix = `${(connectionCounter += 1)}.`;
  private refCounter = 0;
  private closed = false;

  constructor(
    private readonly socket: SharedSocket,
    private readonly descriptor: ChannelDescriptor<ToServer, ToClient, string, any>,
    private readonly validate: { inbound: boolean; outbound: boolean },
  ) {
    this.validateInbound = validate.inbound ? descriptor.validators?.toClient : undefined;
    this.validateOutbound = validate.outbound
      ? descriptor.validators?.toServer
      : undefined;

    this.unsubscribers.push(socket.onFrame((frame) => this.route(frame)));
    this.unsubscribers.push(socket.onOpen(() => void this.resubscribe()));
    this.unsubscribers.push(socket.onTerminate(() => this.handleTerminated()));
  }

  get status(): SocketStatus {
    return this.socket.status;
  }

  get url(): string {
    return this.socket.url;
  }

  onStatus(handler: (status: SocketStatus) => void): () => void {
    return this.socket.onStatus(handler);
  }

  /**
   * Resolve once the socket is open.
   *
   * Sends are queued until then, so this is only needed when a script wants to fail
   * fast on an unreachable server rather than buffer.
   */
  ready(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (this.socket.status === 'open') return Promise.resolve();
    return firstMessage<SocketStatus>(
      (handler) =>
        this.socket.onStatus((status) => {
          if (status === 'open') handler(status);
        }),
      { ...options, label: `channel "${this.descriptor.name}" to open` },
    ).then(() => undefined);
  }

  /** Resolve with the next message carrying this action. */
  once<A extends ToClient['action']>(
    action: A,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<Extract<ToClient, { action: A }>> {
    return firstMessage<Extract<ToClient, { action: A }>>(
      (handler) => this.on(action, handler),
      { ...options, label: `action "${action}"` },
    );
  }

  /**
   * Iterate messages with `for await`. Ends when the connection closes or the signal
   * aborts.
   */
  stream(options: StreamOptions = {}): MessageStream<ToClient> {
    return trackStream(this.streams, (handler) => this.emitter.onAny(handler), options);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ToClient> {
    return this.stream();
  }

  /** `envelope` holds the frame's routing fields, such as a broadcast's `seq`. */
  on<A extends ToClient['action']>(
    action: A,
    handler: (message: Extract<ToClient, { action: A }>, envelope: Envelope) => void,
  ): () => void {
    return this.emitter.on(action, handler);
  }

  onAny(handler: (message: ToClient, envelope: Envelope) => void): () => void {
    return this.emitter.onAny(handler);
  }

  /** Messages that arrived with no handler for their action. */
  onUnhandled(handler: (message: ToClient, envelope: Envelope) => void): () => void {
    return this.emitter.onUnhandled(handler);
  }

  /** Server-side `error` frames, which chanx sends in place of the expected reply. */
  onError(handler: (error: ChanxErrorFrame) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /** `complete` / `event_complete` / `group_complete`, if the server sends them. */
  onComplete(handler: (message: ChanxMessage) => void): () => void {
    this.completeHandlers.add(handler);
    return () => this.completeHandlers.delete(handler);
  }

  /** Throws when outbound validation rejects the message: that is a caller bug. */
  send(message: ToServer): void {
    this.validateOutbound?.(message);
    this.socket.send(withEnvelope(message, {}));
  }

  /**
   * Send and wait for the frame carrying the same `ref`.
   *
   * Resolves on the first matching frame. Needs chanx 2.11.2+, the first release to
   * echo the ref on replies to untopiced frames; earlier servers time out here.
   */
  request(message: ToServer, options: RequestOptions = {}): Promise<ChanxMessage> {
    this.validateOutbound?.(message);
    return this.dispatchRequest(message, undefined, options.timeout);
  }

  /**
   * Take a handle on a topic: `connection.topic(roomTopic.with({ room_name: 'lobby' }))`.
   * Handles are shared per resolved topic string and reference counted, so two
   * components wanting `room:lobby` get one subscription.
   */
  topic<TS extends ChanxMessage, TC extends ChanxMessage>(
    ref: TopicRef<TS, TC, string>,
  ): TopicHandle<TS, TC> {
    const existing = this.topics.get(ref.topic);
    if (existing) {
      existing.refs += 1;
      return existing.handle as TopicHandle<TS, TC>;
    }
    const handle = new TopicHandle<TS, TC>(this, ref, this.validate);
    this.topics.set(ref.topic, { handle, refs: 1 });
    return handle;
  }

  /** @internal TopicHost */
  sendTopic(topic: string, message: object): void {
    this.socket.send(withEnvelope(message, { topic }));
  }

  /** @internal TopicHost */
  requestTopic(topic: string, message: object, timeout?: number): Promise<ChanxMessage> {
    return this.dispatchRequest(message, topic, timeout);
  }

  /** @internal TopicHost */
  releaseTopic(topic: string): void {
    const entry = this.topics.get(topic);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.topics.delete(topic);
    this.dropSubscription(entry.handle);
    entry.handle.clearHandlers();
  }

  /** @internal TopicHost */
  claimSubscription(topic: string): void {
    this.socket.claimTopic(topic);
  }

  /** @internal TopicHost */
  releaseSubscription(topic: string): boolean {
    return this.socket.releaseTopic(topic);
  }

  /** Give up a handle's subscription, telling the server only if nobody else holds it. */
  private dropSubscription(handle: TopicHandle<any, any>): void {
    if (!handle.subscribed) return;
    handle.subscribed = false;
    if (this.socket.releaseTopic(handle.topic) && this.socket.status === 'open') {
      this.sendTopic(handle.topic, { action: 'unsubscribe', payload: null });
    }
  }

  /**
   * Close the socket for every consumer sharing it, not just this one.
   *
   * `close()` gives up this consumer's claim and leaves the socket to the others;
   * this ends it outright, e.g. on logout or when the server-side identity changed.
   * The next `connect()` to the same URL opens a fresh socket.
   */
  terminate(code = 1000, reason = ''): void {
    this.socket.terminate(code, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Connection closed before the reply arrived'));
    }
    this.pending.clear();
    // On a shared socket the socket outlives this connection, so its subscriptions
    // must be released explicitly or the server keeps pushing them.
    for (const { handle } of this.topics.values()) {
      this.dropSubscription(handle);
      handle.clearHandlers();
    }
    this.topics.clear();
    // End open streams, or a `for await` loop would wait for a message that can no
    // longer arrive.
    for (const stream of [...this.streams]) stream.close();
    this.emitter.clear();
    this.errorHandlers.clear();
    this.completeHandlers.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.socket.release();
  }

  private dispatchRequest(
    message: object,
    topic: string | undefined,
    timeout = DEFAULT_REQUEST_TIMEOUT,
  ): Promise<ChanxMessage> {
    this.refCounter += 1;
    const ref = `${this.refPrefix}${this.refCounter}`;
    return new Promise<ChanxMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        const target = topic ? `topic "${topic}"` : `channel "${this.descriptor.name}"`;
        reject(new Error(`Request on ${target} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(ref, { resolve, reject, timer });
      this.socket.send(
        withEnvelope(message, topic === undefined ? { ref } : { topic, ref }),
      );
    });
  }

  private route(frame: RawFrame): void {
    const ref = frame.ref;
    if (ref !== undefined) {
      const waiter = this.pending.get(String(ref));
      if (waiter) {
        this.pending.delete(String(ref));
        clearTimeout(waiter.timer);
        const message = stripEnvelope(frame);
        if (message.action === ERROR_ACTION) {
          waiter.reject(new ChanxRequestError(message as unknown as ChanxErrorFrame));
        } else {
          waiter.resolve(message);
        }
        return;
      }
      // A reply to a request another consumer of this socket made. Every connection
      // sees every frame, so without this one consumer's reply would reach another's
      // handlers. Later frames under our own ref (a second reply, or one arriving after
      // its request timed out) fall through and are delivered like any other.
      if (!String(ref).startsWith(this.refPrefix)) return;
    }

    if (frame.topic !== undefined) {
      this.topics.get(String(frame.topic))?.handle.dispatch(frame);
      return;
    }

    const message = stripEnvelope(frame);
    if (isFrameworkAction(message.action)) {
      this.absorb(message);
      return;
    }
    try {
      // Checked, not replaced: a parser that strips unknown keys would make the message
      // differ between validated and unvalidated builds.
      this.validateInbound?.(message);
    } catch (error) {
      reportError(error);
      return;
    }
    this.emitter.emit(message as ToClient, envelopeOf(frame));
  }

  private absorb(message: ChanxMessage): void {
    if (message.action === ERROR_ACTION) {
      const error = message as unknown as ChanxErrorFrame;
      for (const handler of [...this.errorHandlers]) safely(handler, error);
      return;
    }
    if ((COMPLETE_ACTIONS as readonly string[]).includes(message.action)) {
      for (const handler of [...this.completeHandlers]) safely(handler, message);
    }
  }

  /** The socket was terminated under this connection: fail fast rather than hang. */
  private handleTerminated(): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Socket was terminated before the reply arrived'));
    }
    this.pending.clear();
    // The server dropped these with the socket; there is nothing left to unsubscribe.
    for (const { handle } of this.topics.values()) {
      handle.subscribed = false;
      handle.endStreams();
    }
    for (const stream of [...this.streams]) stream.close();
  }

  private async resubscribe(): Promise<void> {
    for (const { handle } of this.topics.values()) {
      if (!handle.subscribed) continue;
      try {
        await handle.subscribe();
      } catch {
        // Reported through `onSubscribeError`, and `subscribed` is now false.
      }
    }
  }
}

/** Thrown from `request()` when the server answered with an `error` frame. */
export class ChanxRequestError extends Error {
  readonly frame: ChanxErrorFrame;

  constructor(frame: ChanxErrorFrame) {
    super(`chanx error: ${JSON.stringify(frame.payload)}`);
    this.name = 'ChanxRequestError';
    this.frame = frame;
  }
}
