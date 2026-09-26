/**
 * Solid signals and accessors.
 *
 * @module solid
 */
import type { Accessor } from 'solid-js';
import { createMemo, createSignal, getOwner, onCleanup } from 'solid-js';
import { isServer } from 'solid-js/web';

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
import type { SocketStatus } from '../core/socket';
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

export interface ChannelResult<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
> {
  status: Accessor<SocketStatus>;
  lastMessage: Accessor<ToClient | null>;
  messages: Accessor<ToClient[]>;
  clearMessages: () => void;
  send: (message: ToServer) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  connection: () => ChannelConnection<ToServer, ToClient> | null;
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Open (or join) a channel for the lifetime of the current owner.
 *
 * Cleanup registers with `onCleanup` when there is an owner; outside one, call `close()`.
 * Nothing connects during server rendering. Options are read once: for new params,
 * create it again (inside `createMemo` or a keyed `<Show>`).
 */
export function createChannel<D extends ChannelDescriptor<any, any, any, any>>(
  descriptor: D,
  options: ControllerOptions<AddressOf<D>, ToClientOf<D>> & { client?: ChanxClient } = {},
): ChannelResult<ToServerOf<D>, ToClientOf<D>> {
  type ToClient = ToClientOf<D>;

  const controller = createChannelController(
    options.client ?? defaultClient,
    descriptor,
    options,
  );

  const [snapshot, setSnapshot] = createSignal<ChannelSnapshot<ToClient>>(
    controller.getSnapshot() as ChannelSnapshot<ToClient>,
  );

  const unsubscribe = controller.subscribe(() =>
    // The controller replaces the snapshot object on every change, so identity is
    // enough to tell Solid something happened.
    setSnapshot(controller.getSnapshot() as ChannelSnapshot<ToClient>),
  );
  if (!isServer) controller.start();
  setSnapshot(controller.getSnapshot() as ChannelSnapshot<ToClient>);

  const close = () => {
    unsubscribe();
    controller.stop();
  };
  if (getOwner()) onCleanup(close);

  return {
    status: createMemo(() => snapshot().status),
    lastMessage: createMemo(() => snapshot().lastMessage),
    messages: createMemo(() => snapshot().messages),
    clearMessages: () => controller.clearMessages(),
    send: (message) => controller.send(message),
    request: (message, requestOptions) => controller.request(message, requestOptions),
    connection: () => controller.getConnection(),
    close,
    terminate: (code, reason) => controller.terminate(code, reason),
  };
}

export interface TopicsResult<ToServer extends ChanxMessage, T extends TopicRef> {
  status: Accessor<SocketStatus>;
  lastMessage: Accessor<TopicsSnapshot<T>['lastMessage']>;
  messages: Accessor<TopicsSnapshot<T>['messages']>;
  subscribed: Accessor<string[]>;
  handles: Accessor<TopicsSnapshot<T>['handles']>;
  clearMessages: () => void;
  /** Send on the channel itself, not on a topic. */
  send: (message: ToServer) => void;
  /** Send on one of the joined topics, addressed by its resolved name. */
  sendTopic: (topic: string, message: ToServerOf<T>) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join several topics over the channel's single connection: for a set that varies at
 * runtime. For one topic, `createTopic` is simpler and fully typed.
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
): TopicsResult<ToServerOf<D>, Refs[number]> {
  const controller = createTopicsController<D, Refs>(
    options.client ?? defaultClient,
    descriptor,
    options,
  );

  const [snapshot, setSnapshot] = createSignal(controller.getSnapshot());
  const unsubscribe = controller.subscribe(() => setSnapshot(controller.getSnapshot()));
  if (!isServer) controller.start();
  setSnapshot(controller.getSnapshot());

  const close = () => {
    unsubscribe();
    controller.stop();
  };
  if (getOwner()) onCleanup(close);

  return {
    status: createMemo(() => snapshot().status),
    lastMessage: createMemo(() => snapshot().lastMessage),
    messages: createMemo(() => snapshot().messages),
    subscribed: createMemo(() => snapshot().subscribed),
    handles: createMemo(() => snapshot().handles),
    clearMessages: () => controller.clearMessages(),
    send: (message) => controller.send(message),
    sendTopic: (topic, message) => controller.sendTopic(topic, message),
    request: (message, requestOptions) => controller.request(message, requestOptions),
    close,
    terminate: (code, reason) => controller.terminate(code, reason),
  };
}

export interface TopicResult<T extends TopicRef> {
  status: Accessor<SocketStatus>;
  subscribed: Accessor<boolean>;
  lastMessage: Accessor<TopicSnapshot<T>['lastMessage']>;
  messages: Accessor<TopicSnapshot<T>['messages']>;
  /** The topic's handle while joined. */
  handle: () => TopicHandle<ToServerOf<T>, ToClientOf<T>> | null;
  clearMessages: () => void;
  /** Send on the topic. */
  send: (message: ToServerOf<T>) => void;
  /** Send on the topic and wait for the reply carrying the same `ref`. */
  request: (message: ToServerOf<T>, options?: RequestOptions) => Promise<ChanxMessage>;
  close: () => void;
  /** Close the socket for every consumer sharing it. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join one topic, typed from that topic throughout:
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
): TopicResult<T> {
  const controller = createTopicController<D, T>(
    options.client ?? defaultClient,
    descriptor,
    topic,
    options,
  );

  const [snapshot, setSnapshot] = createSignal(controller.getSnapshot());
  const unsubscribe = controller.subscribe(() => setSnapshot(controller.getSnapshot()));
  if (!isServer) controller.start();
  setSnapshot(controller.getSnapshot());

  const close = () => {
    unsubscribe();
    controller.stop();
  };
  if (getOwner()) onCleanup(close);

  return {
    status: createMemo(() => snapshot().status),
    subscribed: createMemo(() => snapshot().subscribed),
    lastMessage: createMemo(() => snapshot().lastMessage),
    messages: createMemo(() => snapshot().messages),
    handle: () => controller.getHandle(),
    clearMessages: () => controller.clearMessages(),
    send: (message) => controller.send(message),
    request: (message, requestOptions) => controller.request(message, requestOptions),
    close,
    terminate: (code, reason) => controller.terminate(code, reason),
  };
}
