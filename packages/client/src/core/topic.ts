import type { TopicDescriptor, TopicRef, Validator } from './descriptor';
import { ActionEmitter } from './emitter';
import type { ChanxMessage, Envelope, RawFrame } from './protocol';
import { envelopeOf, isFrameworkAction, stripEnvelope } from './protocol';
import type { MessageStream, StreamOptions } from './stream';
import { firstMessage, trackStream } from './stream';
import { reportError, safely } from './report';

/** What a topic needs from the connection that owns the socket. */
export interface TopicHost {
  sendTopic(topic: string, message: object): void;
  requestTopic(topic: string, message: object, timeout?: number): Promise<ChanxMessage>;
  releaseTopic(topic: string): void;
  claimSubscription(topic: string): void;
  /** True when no other handle on the socket still holds the subscription. */
  releaseSubscription(topic: string): boolean;
}

export interface SubscribeOptions {
  timeout?: number;
}

export interface TopicRequestOptions {
  timeout?: number;
}

/**
 * A typed view of one topic on a shared connection.
 *
 * Mirrors chanx's `BaseTopicHandle`: the topic string travels on the envelope, so
 * several handles multiplex over the single socket their channel opened.
 */
export class TopicHandle<
  ToServer extends ChanxMessage = ChanxMessage,
  ToClient extends ChanxMessage = ChanxMessage,
> {
  readonly topic: string;

  private isSubscribed = false;
  /**
   * Set by an explicit `unsubscribe()`. On a shared socket the server subscription may
   * outlive it for another consumer, so frames keep arriving; this handle must stop
   * delivering them regardless.
   */
  private muted = false;
  private readonly subscribedListeners = new Set<(subscribed: boolean) => void>();
  private readonly subscribeErrorListeners = new Set<(error: unknown) => void>();
  private readonly streams = new Set<MessageStream<ToClient>>();

  /**
   * Whether the server has confirmed this subscription on the current socket and it has
   * not since been dropped by `unsubscribe`, release, or the socket being terminated.
   */
  get subscribed(): boolean {
    return this.isSubscribed;
  }

  set subscribed(value: boolean) {
    if (this.isSubscribed === value) return;
    this.isSubscribed = value;
    for (const listener of [...this.subscribedListeners]) safely(listener, value);
  }

  /** Follow `subscribed` as it changes, so view state cannot drift from it. */
  onSubscribedChange(listener: (subscribed: boolean) => void): () => void {
    this.subscribedListeners.add(listener);
    return () => this.subscribedListeners.delete(listener);
  }

  /**
   * Every failed subscribe, including the automatic resubscribe after a reconnect,
   * which has no caller to reject.
   */
  onSubscribeError(listener: (error: unknown) => void): () => void {
    this.subscribeErrorListeners.add(listener);
    return () => this.subscribeErrorListeners.delete(listener);
  }

  private readonly emitter = new ActionEmitter<ToClient>();
  private readonly validateInbound: Validator<ToClient> | undefined;
  private readonly validateOutbound: Validator<ToServer> | undefined;

  constructor(
    private readonly host: TopicHost,
    ref: TopicRef<ToServer, ToClient, string>,
    validate: { inbound: boolean; outbound: boolean },
  ) {
    const descriptor: TopicDescriptor<ToServer, ToClient, string> = ref.descriptor;
    this.topic = ref.topic;
    this.validateInbound = validate.inbound ? descriptor.validators?.toClient : undefined;
    this.validateOutbound = validate.outbound
      ? descriptor.validators?.toServer
      : undefined;
  }

  async subscribe(options: SubscribeOptions = {}): Promise<ChanxMessage> {
    // Unmute before the request: the server pushes its snapshot right after confirming.
    this.muted = false;
    let reply: ChanxMessage;
    try {
      reply = await this.host.requestTopic(
        this.topic,
        { action: 'subscribe', payload: null },
        options.timeout,
      );
    } catch (error) {
      // A resubscribe that fails leaves nothing subscribed on the new socket.
      if (this.subscribed) {
        this.subscribed = false;
        this.host.releaseSubscription(this.topic);
      }
      for (const listener of [...this.subscribeErrorListeners]) safely(listener, error);
      throw error;
    }
    // A resubscribe after reconnect keeps its existing claim rather than adding one.
    if (!this.subscribed) {
      this.subscribed = true;
      this.host.claimSubscription(this.topic);
    }
    return reply;
  }

  /**
   * Stop receiving this topic on this handle.
   *
   * Other consumers of the same socket are unaffected: the server is only told to
   * unsubscribe once no handle on the socket still holds the topic. Within one
   * connection, `topic()` hands every caller the same handle, so this stops it for all of
   * them; use `release()` to drop just one caller's claim.
   */
  async unsubscribe(options: SubscribeOptions = {}): Promise<ChanxMessage> {
    const acknowledged: ChanxMessage = { action: 'unsubscribed' };
    this.muted = true;
    if (!this.subscribed) return acknowledged;
    this.subscribed = false;
    // Another consumer of this socket still wants the topic; the server must keep it.
    if (!this.host.releaseSubscription(this.topic)) return acknowledged;
    return this.host.requestTopic(
      this.topic,
      { action: 'unsubscribe', payload: null },
      options.timeout,
    );
  }

  send(message: ToServer): void {
    this.validateOutbound?.(message);
    this.host.sendTopic(this.topic, message);
  }

  /** Send and wait for the frame carrying the same `ref`. */
  request(message: ToServer, options: TopicRequestOptions = {}): Promise<ChanxMessage> {
    this.validateOutbound?.(message);
    return this.host.requestTopic(this.topic, message, options.timeout);
  }

  /** `envelope.seq` orders a topic's events, e.g. a replay overlapping live ones. */
  on<A extends ToClient['action']>(
    action: A,
    handler: (message: Extract<ToClient, { action: A }>, envelope: Envelope) => void,
  ): () => void {
    return this.emitter.on(action, handler);
  }

  onAny(handler: (message: ToClient, envelope: Envelope) => void): () => void {
    return this.emitter.onAny(handler);
  }

  onUnhandled(handler: (message: ToClient, envelope: Envelope) => void): () => void {
    return this.emitter.onUnhandled(handler);
  }

  /** Resolve with the next message on this topic carrying this action. */
  once<A extends ToClient['action']>(
    action: A,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<Extract<ToClient, { action: A }>> {
    return firstMessage<Extract<ToClient, { action: A }>>(
      (handler) => this.on(action, handler),
      { ...options, label: `action "${action}" on topic "${this.topic}"` },
    );
  }

  /**
   * Iterate this topic's messages with `for await`. Ends when the last consumer
   * releases the topic, the connection closes, or the socket is terminated.
   */
  stream(options: StreamOptions = {}): MessageStream<ToClient> {
    return trackStream(this.streams, (handler) => this.emitter.onAny(handler), options);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ToClient> {
    return this.stream();
  }

  /**
   * Drop one consumer's claim. Handlers registered through `on()` are torn down by the
   * disposer it returned, not here: this handle may still be serving other consumers.
   * Each `connection.topic()` call must be matched by exactly one `release()`.
   */
  release(): void {
    this.host.releaseTopic(this.topic);
  }

  /** @internal Called by the connection once the last consumer has released. */
  clearHandlers(): void {
    this.endStreams();
    this.emitter.clear();
    this.subscribedListeners.clear();
    this.subscribeErrorListeners.clear();
  }

  /** @internal End open streams, so no `for await` waits on a topic that is gone. */
  endStreams(): void {
    for (const stream of [...this.streams]) stream.close();
  }

  /** @internal */
  dispatch(frame: RawFrame): void {
    if (this.muted) return;
    const message = stripEnvelope(frame);
    if (isFrameworkAction(message.action)) return;
    try {
      // Checked, not replaced: a parser that strips unknown keys would make the
      // message differ between validated and unvalidated builds.
      this.validateInbound?.(message);
    } catch (error) {
      reportError(error);
      return;
    }
    this.emitter.emit(message as ToClient, envelopeOf(frame));
  }
}
