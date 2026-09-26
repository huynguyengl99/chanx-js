/**
 * Svelte stores, for Svelte 4 and 5.
 *
 * @module svelte
 */
import { onDestroy, onMount } from 'svelte';
import type { Readable } from 'svelte/store';
import { writable } from 'svelte/store';

import type { ChanxClient, ClientOptions } from '../core/client';
import { createClient } from '../core/client';
import type { ChannelConnection, RequestOptions } from '../core/connection';
import type {
  ChannelSnapshot,
  ControllerOptions,
  TopicControllerOptions,
  TopicsControllerOptions,
  TopicSnapshot,
  TopicsSnapshot,
} from '../core/controller';
import {
  createChannelController,
  createTopicController,
  createTopicsController,
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
import type { TopicHandle } from '../core/topic';

export type { BufferMode } from '../core/controller';
export type { TopicMessage, TopicRef } from '../core/descriptor';
export type { ActionHandler, HandlerMap } from '../core/batch';

let defaultClient: ChanxClient = createClient();

/** Set the client used by `createChannel` and `createTopics`. */
export function setDefaultClient(options: ClientOptions | ChanxClient): void {
  defaultClient = 'connect' in options ? options : createClient(options);
}

export function getChanxClient(): ChanxClient {
  return defaultClient;
}

/**
 * Inside a component, connect on mount and tear down on destroy. Mount never happens
 * during server rendering, so no socket is opened on the server. Outside a component,
 * connect now; the caller owns `close()`.
 */
function bindLifecycle(start: () => void, teardown: () => void): void {
  try {
    onMount(start);
    onDestroy(teardown);
  } catch {
    // Not called during component initialisation.
    start();
  }
}

export interface ChannelStore<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
> extends Readable<ChannelSnapshot<ToClient>> {
  send: (message: ToServer) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  clearMessages: () => void;
  getConnection: () => ChannelConnection<ToServer, ToClient> | null;
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Open (or join) a channel as a store: `$chat.status`, `$chat.lastMessage`.
 *
 * Inside a component it connects on mount and closes on destroy. Outside one it connects
 * at once; call `close()` yourself. Options are read once: for new params, create a new
 * store.
 */
export function createChannel<D extends ChannelDescriptor<any, any, any, any>>(
  descriptor: D,
  options: ControllerOptions<AddressOf<D>, ToClientOf<D>> & { client?: ChanxClient } = {},
): ChannelStore<ToServerOf<D>, ToClientOf<D>> {
  type ToClient = ToClientOf<D>;

  const controller = createChannelController(
    options.client ?? defaultClient,
    descriptor,
    options,
  );

  // `writable` rather than `readable`: a readable's start function only runs while it
  // has a subscriber, so `get(store)` would report the snapshot captured at creation.
  const store = writable(controller.getSnapshot() as ChannelSnapshot<ToClient>);
  const unsubscribe = controller.subscribe(() =>
    store.set(controller.getSnapshot() as ChannelSnapshot<ToClient>),
  );

  const close = () => {
    unsubscribe();
    controller.stop();
  };
  // The controller owns the connection for as long as the store lives, rather than only
  // while subscribed, so a component can send before anything reads the store.
  bindLifecycle(() => controller.start(), close);

  return {
    subscribe: store.subscribe,
    send: (message) => controller.send(message),
    request: (message, requestOptions) => controller.request(message, requestOptions),
    clearMessages: () => controller.clearMessages(),
    getConnection: () => controller.getConnection(),
    close,
    terminate: (code, reason) => controller.terminate(code, reason),
  };
}

export interface TopicsStore<
  ToServer extends ChanxMessage,
  T extends TopicRef,
> extends Readable<TopicsSnapshot<T>> {
  /** Send on the channel itself, not on a topic. */
  send: (message: ToServer) => void;
  /** Send on one of the joined topics, addressed by its resolved name. */
  sendTopic: (topic: string, message: ToServerOf<T>) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  clearMessages: () => void;
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join several topics over the channel's single connection, as a store: for a set that
 * varies at runtime. For one topic, `createTopic` is simpler and fully typed. Same
 * lifecycle as `createChannel`.
 */
export function createTopics<
  D extends ChannelDescriptor<any, any, any, any>,
  const Refs extends readonly TopicRefOf<D>[],
>(
  descriptor: D,
  options: TopicsControllerOptions<AddressOf<D>, Refs[number]> & {
    topics: Refs;
    client?: ChanxClient;
  },
): TopicsStore<ToServerOf<D>, Refs[number]> {
  const controller = createTopicsController<D, Refs>(
    options.client ?? defaultClient,
    descriptor,
    options,
  );

  const store = writable(controller.getSnapshot());
  const unsubscribe = controller.subscribe(() => store.set(controller.getSnapshot()));

  const close = () => {
    unsubscribe();
    controller.stop();
  };
  bindLifecycle(() => controller.start(), close);

  return {
    subscribe: store.subscribe,
    send: (message) => controller.send(message),
    sendTopic: (topic, message) => controller.sendTopic(topic, message),
    request: (message, requestOptions) => controller.request(message, requestOptions),
    clearMessages: () => controller.clearMessages(),
    close,
    terminate: (code, reason) => controller.terminate(code, reason),
  };
}

export interface TopicStore<T extends TopicRef> extends Readable<TopicSnapshot<T>> {
  /** Send on the topic. */
  send: (message: ToServerOf<T>) => void;
  /** Send on the topic and wait for the reply carrying the same `ref`. */
  request: (message: ToServerOf<T>, options?: RequestOptions) => Promise<ChanxMessage>;
  /** The topic's handle while joined. */
  getHandle: () => TopicHandle<ToServerOf<T>, ToClientOf<T>> | null;
  clearMessages: () => void;
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join one topic as a store, typed from that topic throughout:
 * `createTopic(hub, hub.topics.roomTopic.with({ room_name: 'lobby' }))`. Same lifecycle
 * as `createChannel`.
 */
export function createTopic<
  D extends ChannelDescriptor<any, any, any, any>,
  T extends TopicRefOf<D>,
>(
  descriptor: D,
  topic: T,
  options: TopicControllerOptions<AddressOf<D>, T> & { client?: ChanxClient } = {},
): TopicStore<T> {
  const controller = createTopicController<D, T>(
    options.client ?? defaultClient,
    descriptor,
    topic,
    options,
  );

  const store = writable(controller.getSnapshot());
  const unsubscribe = controller.subscribe(() => store.set(controller.getSnapshot()));

  const close = () => {
    unsubscribe();
    controller.stop();
  };
  bindLifecycle(() => controller.start(), close);

  return {
    subscribe: store.subscribe,
    send: (message) => controller.send(message),
    request: (message, requestOptions) => controller.request(message, requestOptions),
    getHandle: () => controller.getHandle(),
    clearMessages: () => controller.clearMessages(),
    close,
    terminate: (code, reason) => controller.terminate(code, reason),
  };
}
