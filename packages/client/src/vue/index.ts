/**
 * Vue composables returning refs.
 *
 * @module vue
 */
import type { App, InjectionKey, Ref } from 'vue';
import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  inject,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
} from 'vue';

import type { ChanxClient, ClientOptions } from '../core/client';
import { createClient } from '../core/client';
import type { ChannelConnection, RequestOptions } from '../core/connection';
import type {
  ChannelSnapshot,
  ControllerOptions,
  TopicController,
  TopicControllerOptions,
  TopicsController,
  TopicsControllerOptions,
  TopicSnapshot,
  TopicsSnapshot,
} from '../core/controller';
import {
  connectionKey,
  createChannelController,
  createTopicController,
  createTopicsController,
  topicsKey,
} from '../core/controller';
import type {
  AddressOf,
  ChannelDescriptor,
  ToClientOf,
  ToServerOf,
  TopicRef,
  TopicRefOf,
} from '../core/descriptor';
import type { ChanxMessage } from '../core/protocol';
import type { SocketStatus } from '../core/socket';

import type { TopicHandle } from '../core/topic';
export type { BufferMode } from '../core/controller';
export type { TopicMessage, TopicRef } from '../core/descriptor';
export type { ActionHandler, HandlerMap } from '../core/batch';

const CLIENT_KEY: InjectionKey<ChanxClient> = Symbol('chanx.client');

let fallbackClient: ChanxClient = createClient();

/** Register a client app-wide: `app.use(chanxPlugin, { baseUrl })`. */
export const chanxPlugin = {
  install(app: App, options: ClientOptions | ChanxClient = {}) {
    const client = 'connect' in options ? options : createClient(options);
    app.provide(CLIENT_KEY, client);
  },
};

/** Set the client used when the plugin is not installed. */
export function setDefaultClient(options: ClientOptions | ChanxClient): void {
  fallbackClient = 'connect' in options ? options : createClient(options);
}

export function useChanxClient(): ChanxClient {
  return inject(CLIENT_KEY, fallbackClient);
}

type MaybeRef<T> = T | Ref<T>;

/** Values that may be refs, so a route or token change reconnects without remounting. */
interface ReactiveConnectOptions {
  params?: MaybeRef<Record<string, string | number>>;
  queryParams?: MaybeRef<Record<string, string | number>>;
}

function resolveReactive<T extends ReactiveConnectOptions>(options: T) {
  return {
    ...options,
    params: toValue(options.params) ?? {},
    queryParams: toValue(options.queryParams),
  };
}

/**
 * Run `start` once the component is mounted, or now outside a component. Mount never
 * happens during server rendering, so no socket is opened on the server.
 */
function whenMounted(start: () => void): () => boolean {
  let mounted = !getCurrentInstance();
  if (mounted) start();
  else
    onMounted(() => {
      mounted = true;
      start();
    });
  return () => mounted;
}

export interface UseChannelResult<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
> {
  status: Ref<SocketStatus>;
  lastMessage: Ref<ToClient | null>;
  messages: Ref<ToClient[]>;
  clearMessages: () => void;
  send: (message: ToServer) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  connection: Ref<ChannelConnection<ToServer, ToClient> | null>;
  /** Release this consumer's claim; the socket stays up for any others. */
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Open (or join) a channel for the lifetime of the current effect scope.
 *
 * Inside a component it connects on mount and releases on unmount. Outside one it
 * connects at once; call the returned `close()`. `params` and `queryParams` may be refs:
 * a change reconnects.
 */
export function useChannel<D extends ChannelDescriptor<any, any, any, any>>(
  descriptor: D,
  options: Omit<
    ControllerOptions<AddressOf<D>, ToClientOf<D>>,
    'params' | 'queryParams'
  > &
    ReactiveConnectOptions = {},
): UseChannelResult<ToServerOf<D>, ToClientOf<D>> {
  type ToServer = ToServerOf<D>;
  type ToClient = ToClientOf<D>;

  const client = useChanxClient();
  // Rendered before mount, so a disabled channel must already read `closed`.
  const status = ref<SocketStatus>(
    options.enabled === false ? 'closed' : 'connecting',
  ) as Ref<SocketStatus>;
  const lastMessage = shallowRef<ToClient | null>(null);
  const messages = shallowRef<ToClient[]>([]);
  const connection = shallowRef<ChannelConnection<ToServer, ToClient> | null>(null);

  let current: ReturnType<typeof createChannelController<D>> | null = null;
  let unsubscribe: (() => void) | null = null;

  const teardown = () => {
    unsubscribe?.();
    unsubscribe = null;
    current?.stop();
    current = null;
    connection.value = null;
  };

  const build = () => {
    teardown();
    const controller = createChannelController(
      client,
      descriptor,
      resolveReactive(options) as ControllerOptions<AddressOf<D>, ToClientOf<D>>,
    );
    current = controller;

    const apply = () => {
      const snapshot = controller.getSnapshot() as ChannelSnapshot<ToClient>;
      status.value = snapshot.status;
      lastMessage.value = snapshot.lastMessage;
      messages.value = snapshot.messages;
      connection.value = controller.getConnection();
    };

    unsubscribe = controller.subscribe(apply);
    controller.start();
    apply();
  };

  const mounted = whenMounted(build);
  watch(
    () => connectionKey(resolveReactive(options)),
    () => {
      if (mounted()) build();
    },
  );

  if (getCurrentScope()) onScopeDispose(teardown);

  return {
    status,
    lastMessage,
    messages,
    connection,
    clearMessages: () => current?.clearMessages(),
    send: (message) => current?.send(message),
    request: (message, requestOptions) =>
      current
        ? current.request(message, requestOptions)
        : Promise.reject(new Error('Channel is not connected')),
    close: teardown,
    terminate: (code, reason) => current?.terminate(code, reason),
  };
}

export interface UseTopicsResult<ToServer extends ChanxMessage, T extends TopicRef> {
  status: Ref<SocketStatus>;
  lastMessage: Ref<TopicsSnapshot<T>['lastMessage']>;
  messages: Ref<TopicsSnapshot<T>['messages']>;
  subscribed: Ref<string[]>;
  handles: Ref<TopicsSnapshot<T>['handles']>;
  clearMessages: () => void;
  /** Send on the channel itself, not on a topic. */
  send: (message: ToServer) => void;
  /** Send on one of the joined topics, addressed by its resolved name. */
  sendTopic: (topic: string, message: ToServerOf<T>) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  close: () => void;
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join several topics over the channel's single connection: for a set that varies at
 * runtime. For one topic, `useTopic` is simpler and fully typed.
 *
 * Same lifecycle as `useChannel`. `params`, `queryParams` and `topics` may be refs: a
 * change rejoins.
 */
export function useTopics<
  D extends ChannelDescriptor<any, any, any, any>,
  T extends TopicRefOf<D>,
>(
  descriptor: D,
  options: Omit<
    TopicsControllerOptions<AddressOf<D>, T>,
    'params' | 'queryParams' | 'topics'
  > &
    ReactiveConnectOptions & { topics: MaybeRef<readonly T[]> },
): UseTopicsResult<ToServerOf<D>, T> {
  const client = useChanxClient();
  const snapshot = shallowRef<TopicsSnapshot<T>>({
    status: options.enabled === false ? 'closed' : 'connecting',
    lastMessage: null,
    messages: [],
    subscribed: [],
    handles: {},
  });

  let current: TopicsController<ToServerOf<D>, T> | null = null;
  let unsubscribe: (() => void) | null = null;

  const resolved = () => ({
    ...resolveReactive(options),
    topics: toValue(options.topics),
  });

  const teardown = () => {
    unsubscribe?.();
    unsubscribe = null;
    current?.stop();
    current = null;
  };

  const build = () => {
    teardown();
    const controller = createTopicsController<D, T>(
      client,
      descriptor,
      resolved() as TopicsControllerOptions<AddressOf<D>, T>,
    );
    current = controller;
    unsubscribe = controller.subscribe(() => {
      snapshot.value = controller.getSnapshot();
    });
    controller.start();
    snapshot.value = controller.getSnapshot();
  };

  const mounted = whenMounted(build);
  watch(
    () => {
      const next = resolved();
      return connectionKey(next) + topicsKey(next.topics);
    },
    () => {
      if (mounted()) build();
    },
  );

  if (getCurrentScope()) onScopeDispose(teardown);

  return {
    status: computed(() => snapshot.value.status),
    lastMessage: computed(() => snapshot.value.lastMessage),
    messages: computed(() => snapshot.value.messages),
    subscribed: computed(() => snapshot.value.subscribed),
    handles: computed(() => snapshot.value.handles),
    clearMessages: () => current?.clearMessages(),
    send: (message) => current?.send(message),
    sendTopic: (topic, message) => current?.sendTopic(topic, message),
    request: (message, requestOptions) =>
      current
        ? current.request(message, requestOptions)
        : Promise.reject(new Error('Channel is not connected')),
    close: teardown,
    terminate: (code, reason) => current?.terminate(code, reason),
  };
}

export interface UseTopicResult<T extends TopicRef> {
  status: Ref<SocketStatus>;
  subscribed: Ref<boolean>;
  lastMessage: Ref<TopicSnapshot<T>['lastMessage']>;
  messages: Ref<TopicSnapshot<T>['messages']>;
  /** The topic's handle while joined. */
  handle: Ref<TopicHandle<ToServerOf<T>, ToClientOf<T>> | null>;
  clearMessages: () => void;
  /** Send on the topic. */
  send: (message: ToServerOf<T>) => void;
  /** Send on the topic and wait for the reply carrying the same `ref`. */
  request: (message: ToServerOf<T>, options?: RequestOptions) => Promise<ChanxMessage>;
  close: () => void;
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join one topic, typed from that topic throughout:
 *
 * ```ts
 * const { lastMessage, send } = useTopic(hub, hub.topics.roomTopic.with({ room_name }));
 * ```
 *
 * Same lifecycle as `useChannel`. The topic may be a ref (or a `computed`): a new topic
 * rejoins.
 */
export function useTopic<
  D extends ChannelDescriptor<any, any, any, any>,
  T extends TopicRefOf<D>,
>(
  descriptor: D,
  topic: MaybeRef<T>,
  options: Omit<TopicControllerOptions<AddressOf<D>, T>, 'params' | 'queryParams'> &
    ReactiveConnectOptions = {},
): UseTopicResult<T> {
  const client = useChanxClient();
  const snapshot = shallowRef<TopicSnapshot<T>>({
    status: options.enabled === false ? 'closed' : 'connecting',
    subscribed: false,
    lastMessage: null,
    messages: [],
  });
  const handle = shallowRef<TopicHandle<ToServerOf<T>, ToClientOf<T>> | null>(null);

  let current: TopicController<T> | null = null;
  let unsubscribe: (() => void) | null = null;

  const teardown = () => {
    unsubscribe?.();
    unsubscribe = null;
    current?.stop();
    current = null;
    handle.value = null;
  };

  const build = () => {
    teardown();
    const controller = createTopicController<D, T>(
      client,
      descriptor,
      toValue(topic),
      resolveReactive(options) as TopicControllerOptions<AddressOf<D>, T>,
    );
    current = controller;
    const apply = () => {
      snapshot.value = controller.getSnapshot();
      handle.value = controller.getHandle();
    };
    unsubscribe = controller.subscribe(apply);
    controller.start();
    apply();
  };

  const mounted = whenMounted(build);
  watch(
    () => connectionKey(resolveReactive(options)) + toValue(topic).topic,
    () => {
      if (mounted()) build();
    },
  );

  if (getCurrentScope()) onScopeDispose(teardown);

  return {
    status: computed(() => snapshot.value.status),
    subscribed: computed(() => snapshot.value.subscribed),
    lastMessage: computed(() => snapshot.value.lastMessage),
    messages: computed(() => snapshot.value.messages),
    handle,
    clearMessages: () => current?.clearMessages(),
    send: (message) => current?.send(message),
    request: (message, requestOptions) =>
      current
        ? current.request(message, requestOptions)
        : Promise.reject(new Error(`Topic "${toValue(topic).topic}" is not joined`)),
    close: teardown,
    terminate: (code, reason) => current?.terminate(code, reason),
  };
}
