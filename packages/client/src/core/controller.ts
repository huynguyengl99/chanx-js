import type { ActionHandler, HandlerMap } from './batch';
import { BatchQueue } from './batch';
import type { ChanxClient, ConnectOptions } from './client';
import type { ChannelConnection, RequestOptions } from './connection';
import type {
  AddressOf,
  ChannelDescriptor,
  ToClientOf,
  ToServerOf,
  TopicMessage,
  TopicRef,
  TopicRefOf,
} from './descriptor';
import type { ChanxErrorFrame, ChanxMessage, Envelope } from './protocol';
import type { SocketStatus } from './socket';
import type { TopicHandle } from './topic';

/**
 * How inbound messages reach the view layer.
 *
 * - `latest` keeps the newest, matching react-use-websocket's `lastJsonMessage`.
 *   Convenient, but two frames in one tick means only the last is seen.
 * - `all` accumulates into `messages`, drained with `clearMessages()`. No drops.
 * - `none` publishes nothing; use the `on` handlers.
 */
export type BufferMode = 'latest' | 'all' | 'none';

export interface ControllerOptions<
  Address extends string,
  ToClient extends ChanxMessage,
> extends ConnectOptions<Address> {
  enabled?: boolean;
  buffer?: BufferMode;
  /** Restrict which actions reach the buffer. Handlers in `on` are unaffected. */
  only?: ReadonlyArray<ToClient['action']>;
  on?: HandlerMap<ToClient>;
  onError?: (error: ChanxErrorFrame) => void;
  /**
   * Messages nothing took: no `on` handler, and kept out of the buffer by `only` or
   * `buffer: 'none'`.
   */
  onUnhandled?: (message: ToClient, envelope: Envelope) => void;
}

const CONTROLLER_KEYS = [
  'enabled',
  'buffer',
  'only',
  'on',
  'onError',
  'onUnhandled',
  'topics',
  'onSubscribeError',
  'client',
] as const;

/** The options that shape the connection, without the controller's own. */
function connectOptionsOf<Address extends string>(
  options: object,
): ConnectOptions<Address> {
  const connect: Record<string, unknown> = { ...options };
  for (const key of CONTROLLER_KEYS) delete connect[key];
  return connect as ConnectOptions<Address>;
}

/**
 * Identity of the connection an options object asks for. Bindings rebuild when it
 * changes, so a new token in `queryParams` reconnects just like new `params` do.
 */
export function connectionKey(
  options: ConnectOptions<string> & { enabled?: boolean },
): string {
  return JSON.stringify([
    options.enabled ?? true,
    options.params ?? {},
    options.queryParams ?? {},
    options.protocols ?? null,
    options.share ?? null,
  ]);
}

export interface ChannelSnapshot<ToClient extends ChanxMessage> {
  status: SocketStatus;
  lastMessage: ToClient | null;
  messages: ToClient[];
}

export interface ChannelController<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
> {
  /** Subscribe to snapshot changes. Returns a disposer. */
  subscribe: (listener: () => void) => () => void;
  /** Stable between changes, so it can back `useSyncExternalStore`. */
  getSnapshot: () => ChannelSnapshot<ToClient>;
  send: (message: ToServer) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  clearMessages: () => void;
  getConnection: () => ChannelConnection<ToServer, ToClient> | null;
  /** Close the socket for every consumer sharing it. See `ChannelConnection.terminate`. */
  terminate: (code?: number, reason?: string) => void;
  /** Replace the options the handlers close over, without reconnecting. */
  setOptions: (options: ControllerOptions<string, ToClient>) => void;
  /** The resolved URL, or null when disabled. Bindings key their lifecycle on this. */
  readonly url: string | null;
  start: () => void;
  stop: () => void;
}

const CLOSED_SNAPSHOT = {
  status: 'closed' as SocketStatus,
  lastMessage: null,
  messages: [],
};

/**
 * Everything a framework binding needs, with no framework in it.
 *
 * Bindings adapt `subscribe`/`getSnapshot` to their own reactivity and call
 * `start`/`stop` on mount and unmount. Keeping the behaviour here means buffering,
 * filtering and batching work identically in React, Vue, Svelte and Solid, and can be
 * tested once without mounting anything.
 */
export function createChannelController<D extends ChannelDescriptor<any, any, any, any>>(
  client: ChanxClient,
  descriptor: D,
  initialOptions: ControllerOptions<AddressOf<D>, ToClientOf<D>> = {},
): ChannelController<ToServerOf<D>, ToClientOf<D>> {
  type ToServer = ToServerOf<D>;
  type ToClient = ToClientOf<D>;

  let options = initialOptions as ControllerOptions<string, ToClient>;
  let connection: ChannelConnection<ToServer, ToClient> | null = null;
  let disposers: Array<() => void> = [];
  let queue: BatchQueue | null = null;

  const listeners = new Set<() => void>();
  let snapshot: ChannelSnapshot<ToClient> = {
    status: initialOptions.enabled === false ? 'closed' : 'connecting',
    lastMessage: null,
    messages: [],
  };

  const url =
    initialOptions.enabled === false
      ? null
      : client.urlFor(descriptor, connectOptionsOf<AddressOf<D>>(initialOptions));

  const publish = (next: Partial<ChannelSnapshot<ToClient>>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };

  const handle = (message: ToClient, envelope: Envelope) => {
    const handler = options.on?.[message.action as ToClient['action']];
    if (typeof handler === 'function') {
      handler(message as never, envelope);
    } else if (handler) {
      queue?.push(message.action, message, envelope, handler.batch);
    }

    const mode = options.buffer ?? 'latest';
    const buffered =
      mode !== 'none' && (!options.only || options.only.includes(message.action));
    if (!buffered) {
      if (!handler) options.onUnhandled?.(message, envelope);
      return;
    }
    if (mode === 'latest') publish({ lastMessage: message });
    else publish({ messages: [...snapshot.messages, message] });
  };

  return {
    url,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,

    setOptions(next) {
      options = next;
    },

    getConnection: () => connection,

    terminate(code, reason) {
      connection?.terminate(code, reason);
    },

    send(message) {
      connection?.send(message);
    },

    request(message, requestOptions) {
      if (!connection) return Promise.reject(new Error('Channel is not connected'));
      return connection.request(message, requestOptions);
    },

    clearMessages() {
      publish({ messages: [] });
    },

    start() {
      if (url === null || connection) {
        if (url === null) publish(CLOSED_SNAPSHOT);
        return;
      }

      const opened = client.connect(
        descriptor,
        connectOptionsOf<AddressOf<D>>(options),
      ) as ChannelConnection<ToServer, ToClient>;
      connection = opened;

      queue = new BatchQueue((action, batched, envelopes) => {
        const handler = options.on?.[action as ToClient['action']];
        if (handler && typeof handler === 'object') {
          handler.handler(batched as never, envelopes);
        }
      });

      disposers = [
        opened.onStatus((status) => publish({ status })),
        opened.onError((error) => options.onError?.(error)),
        opened.onAny(handle),
      ];

      // A shared socket may already be open, and only reports future changes.
      publish({ status: opened.status });
    },

    stop() {
      for (const dispose of disposers) dispose();
      disposers = [];
      queue?.dispose();
      queue = null;
      connection?.close();
      connection = null;
    },
  };
}

export interface TopicsControllerOptions<
  Address extends string,
  Ref extends TopicRef = TopicRef,
> extends Omit<
  ControllerOptions<Address, ChanxMessage>,
  'on' | 'buffer' | 'only' | 'onUnhandled'
> {
  /** Topics to join, each from `topic.with(params)`. */
  topics: readonly Ref[];
  buffer?: BufferMode;
  /** Handlers for the joined topics' messages, keyed by action. */
  on?: HandlerMap<ToClientOf<Ref>>;
  /** Called when a subscription is rejected, typically by an authorization check. */
  onSubscribeError?: (topic: string, error: unknown) => void;
}

/** Identity of a topic set, so bindings resubscribe only when it really changes. */
export function topicsKey(topics: readonly TopicRef[]): string {
  return JSON.stringify(topics.map((ref) => ref.topic));
}

export interface TopicsSnapshot<Ref extends TopicRef = TopicRef> {
  status: SocketStatus;
  lastMessage: TopicMessage<Ref> | null;
  messages: Array<TopicMessage<Ref>>;
  subscribed: string[];
  handles: Record<string, TopicHandle>;
}

export interface TopicsController<
  ToServer extends ChanxMessage,
  Ref extends TopicRef = TopicRef,
> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TopicsSnapshot<Ref>;
  /** Send on the channel itself, not on a topic. */
  send: (message: ToServer) => void;
  /** Send on a joined topic, addressed by its resolved name. */
  sendTopic: (topic: string, message: ToServerOf<Ref>) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  clearMessages: () => void;
  terminate: (code?: number, reason?: string) => void;
  setOptions: (options: TopicsControllerOptions<string, Ref>) => void;
  readonly url: string | null;
  /** Identity of the topic set, so bindings can restart only when it really changes. */
  readonly topicKey: string;
  start: () => void;
  stop: () => void;
}

/**
 * Joins a set of topics over one connection.
 *
 * Subscriptions are reference counted per resolved topic by the connection, so two
 * controllers wanting `room:lobby` share one subscription. Messages on the channel
 * itself are not topic messages and stay out of this controller's buffer and handlers.
 */
export function createTopicsController<
  D extends ChannelDescriptor<any, any, any, any>,
  Ref extends TopicRefOf<D> = TopicRefOf<D>,
>(
  client: ChanxClient,
  descriptor: D,
  initialOptions: TopicsControllerOptions<AddressOf<D>, Ref>,
): TopicsController<ToServerOf<D>, Ref> {
  type ToServer = ToServerOf<D>;
  type Snapshot = TopicsSnapshot<Ref>;

  let options = initialOptions as TopicsControllerOptions<string, Ref>;
  const channelOptions = (next: TopicsControllerOptions<string, Ref>) =>
    ({ ...next, buffer: 'none', on: undefined }) as ControllerOptions<
      AddressOf<D>,
      ToClientOf<D>
    >;

  const channel = createChannelController(client, descriptor, channelOptions(options));

  const listeners = new Set<() => void>();
  let snapshot: Snapshot = {
    status: channel.getSnapshot().status,
    lastMessage: null,
    messages: [],
    subscribed: [],
    handles: {},
  };
  let topicDisposers: Array<() => void> = [];
  let queue: BatchQueue | null = null;
  let cancelled = false;

  const publish = (next: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };

  channel.subscribe(() => publish({ status: channel.getSnapshot().status }));

  const handlerFor = (action: string) =>
    (options.on as Record<string, ActionHandler<ChanxMessage>> | undefined)?.[action];

  return {
    url: channel.url,
    topicKey: topicsKey(initialOptions.topics),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,

    setOptions(next) {
      options = next;
      channel.setOptions(channelOptions(next) as ControllerOptions<string, ChanxMessage>);
    },

    send: (message) => channel.send(message as never),
    terminate: (code, reason) => channel.terminate(code, reason),
    request: (message, requestOptions) =>
      channel.request(message as never, requestOptions),

    sendTopic(topic, message) {
      snapshot.handles[topic]?.send(message);
    },

    clearMessages() {
      publish({ messages: [] });
    },

    start() {
      cancelled = false;
      channel.start();
      const connection = channel.getConnection();
      if (!connection) return;

      queue = new BatchQueue((action, batched, envelopes) => {
        const handler = handlerFor(action);
        if (handler && typeof handler === 'object')
          handler.handler(batched as ChanxMessage[], envelopes);
      });

      const handles: Record<string, TopicHandle> = {};
      // Derived from the handles rather than tracked from the subscribe promise, so a
      // terminate, unsubscribe or release is reflected without special-casing each.
      const syncSubscribed = () =>
        publish({
          subscribed: Object.values(handles)
            .filter((handle) => handle.subscribed)
            .map((handle) => handle.topic),
        });

      for (const ref of options.topics) {
        // One claim per topic, however often it is listed, so stop releases them all.
        if (handles[ref.topic]) continue;
        const handle = connection.topic(ref);
        handles[handle.topic] = handle;

        topicDisposers.push(handle.onSubscribedChange(syncSubscribed));
        // Covers the resubscribe after a reconnect too, which has no promise to catch.
        topicDisposers.push(
          handle.onSubscribeError((error) => {
            if (!cancelled) options.onSubscribeError?.(handle.topic, error);
          }),
        );
        topicDisposers.push(
          handle.onAny((message: ChanxMessage, envelope: Envelope) => {
            const handler = handlerFor(message.action);
            if (typeof handler === 'function') handler(message, envelope);
            else if (handler)
              queue?.push(message.action, message, envelope, handler.batch);

            const mode = options.buffer ?? 'latest';
            if (mode === 'none') return;
            const withTopic = {
              ...message,
              topic: handle.topic,
              ...(envelope.seq === undefined ? {} : { seq: envelope.seq }),
            } as TopicMessage<Ref>;
            if (mode === 'latest') publish({ lastMessage: withTopic });
            else publish({ messages: [...snapshot.messages, withTopic] });
          }),
        );

        // Reported through `onSubscribeError` above.
        void handle.subscribe().catch(() => undefined);
      }

      publish({ handles });
    },

    stop() {
      cancelled = true;
      for (const dispose of topicDisposers) dispose();
      topicDisposers = [];
      queue?.dispose();
      queue = null;
      for (const handle of Object.values(snapshot.handles)) handle.release();
      publish({ handles: {}, subscribed: [] });
      channel.stop();
    },
  } satisfies TopicsController<ToServer, Ref>;
}

export type TopicControllerOptions<
  Address extends string,
  Ref extends TopicRef = TopicRef,
> = Omit<TopicsControllerOptions<Address, Ref>, 'topics'>;

export interface TopicSnapshot<Ref extends TopicRef = TopicRef> {
  status: SocketStatus;
  /** Whether the server has confirmed the subscription. */
  subscribed: boolean;
  lastMessage: TopicMessage<Ref> | null;
  messages: Array<TopicMessage<Ref>>;
}

export interface TopicController<Ref extends TopicRef = TopicRef> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TopicSnapshot<Ref>;
  /** Send on the topic. Dropped when it is not joined (disabled, or not started). */
  send: (message: ToServerOf<Ref>) => void;
  request: (message: ToServerOf<Ref>, options?: RequestOptions) => Promise<ChanxMessage>;
  clearMessages: () => void;
  terminate: (code?: number, reason?: string) => void;
  setOptions: (options: TopicControllerOptions<string, Ref>) => void;
  /** The topic's handle while joined, for everything else a handle offers. */
  getHandle: () => TopicHandle<ToServerOf<Ref>, ToClientOf<Ref>> | null;
  readonly url: string | null;
  /** The resolved topic, so bindings can rejoin only when it changes. */
  readonly topicKey: string;
  start: () => void;
  stop: () => void;
}

/**
 * Joins one topic. The common case, with the topic's own message types throughout: no
 * union to narrow and no topic name to pass when sending.
 */
export function createTopicController<
  D extends ChannelDescriptor<any, any, any, any>,
  Ref extends TopicRefOf<D> = TopicRefOf<D>,
>(
  client: ChanxClient,
  descriptor: D,
  topic: Ref,
  initialOptions: TopicControllerOptions<AddressOf<D>, Ref> = {},
): TopicController<Ref> {
  type Handle = TopicHandle<ToServerOf<Ref>, ToClientOf<Ref>>;

  const inner = createTopicsController<D, Ref>(client, descriptor, {
    ...initialOptions,
    topics: [topic],
  });
  const derive = (from: TopicsSnapshot<Ref>): TopicSnapshot<Ref> => ({
    status: from.status,
    subscribed: from.subscribed.includes(topic.topic),
    lastMessage: from.lastMessage,
    messages: from.messages,
  });

  const listeners = new Set<() => void>();
  let snapshot = derive(inner.getSnapshot());
  inner.subscribe(() => {
    snapshot = derive(inner.getSnapshot());
    for (const listener of [...listeners]) listener();
  });

  const handle = () =>
    (inner.getSnapshot().handles[topic.topic] as Handle | undefined) ?? null;

  return {
    url: inner.url,
    topicKey: inner.topicKey,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    send(message) {
      handle()?.send(message);
    },
    request(message, requestOptions) {
      const joined = handle();
      if (!joined)
        return Promise.reject(new Error(`Topic "${topic.topic}" is not joined`));
      return joined.request(message, requestOptions);
    },
    clearMessages: () => inner.clearMessages(),
    terminate: (code, reason) => inner.terminate(code, reason),
    setOptions: (next) => inner.setOptions({ ...next, topics: [topic] }),
    getHandle: handle,
    start: () => inner.start(),
    stop: () => inner.stop(),
  };
}
