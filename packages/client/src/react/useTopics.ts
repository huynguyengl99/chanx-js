import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { RequestOptions } from '../core/connection';
import type { TopicsControllerOptions, TopicsSnapshot } from '../core/controller';
import { connectionKey, createTopicsController, topicsKey } from '../core/controller';
import type {
  AddressOf,
  ChannelDescriptor,
  ToServerOf,
  TopicRef,
  TopicRefOf,
} from '../core/descriptor';
import type { ChanxMessage } from '../core/protocol';
import { useChanxClient } from './context';

export type UseTopicsOptions<
  Address extends string,
  Ref extends TopicRef,
> = TopicsControllerOptions<Address, Ref>;

export interface UseTopicsResult<
  ToServer extends ChanxMessage,
  Ref extends TopicRef,
> extends TopicsSnapshot<Ref> {
  clearMessages: () => void;
  /** Send on the channel itself, not on a topic. */
  send: (message: ToServer) => void;
  /**
   * Send on one of the joined topics, addressed by its resolved name. For a send typed
   * to exactly one topic, use `useTopic`, or take the handle from `handles`.
   */
  sendTopic: (topic: string, message: ToServerOf<Ref>) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  /** Close the socket for every component sharing it, not just this one. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join several topics over the channel's single connection: for a set that varies at
 * runtime, which hooks cannot do one call per topic. For one topic, `useTopic` is
 * simpler and fully typed.
 *
 * ```ts
 * useTopics(hub, { topics: rooms.map((room) => presence.with({ room })) });
 * ```
 *
 * `lastMessage` and `messages` are typed as any joined topic's messages, each tagged
 * with its `topic`. Subscriptions are reference counted per resolved topic, and resume
 * after a reconnect.
 */
export function useTopics<
  D extends ChannelDescriptor<any, any, any, any>,
  const Refs extends readonly TopicRefOf<D>[],
>(
  descriptor: D,
  options: UseTopicsOptions<AddressOf<D>, Refs[number]> & { topics: Refs },
): UseTopicsResult<ToServerOf<D>, Refs[number]> {
  type Ref = Refs[number];
  const client = useChanxClient();

  const key = connectionKey(options);
  // Identity of the topic set, so re-rendering with a fresh array does not resubscribe.
  const topicKey = topicsKey(options.topics);

  // Rebuilt only when the connection or the topic set changes; handlers are synced by
  // the effect below instead.
  const controller = useMemo(
    () => createTopicsController<D, Refs>(client, descriptor, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, descriptor, key, topicKey],
  );

  useEffect(() => {
    controller.setOptions(options as TopicsControllerOptions<string, Ref>);
  });

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const send = useCallback(
    (message: ToServerOf<D>) => controller.send(message),
    [controller],
  );
  const sendTopic = useCallback(
    (topic: string, message: ToServerOf<Ref>) => controller.sendTopic(topic, message),
    [controller],
  );
  const request = useCallback(
    (message: ToServerOf<D>, requestOptions?: RequestOptions) =>
      controller.request(message, requestOptions),
    [controller],
  );
  const clearMessages = useCallback(() => controller.clearMessages(), [controller]);
  const terminate = useCallback(
    (code?: number, reason?: string) => controller.terminate(code, reason),
    [controller],
  );

  return { ...snapshot, send, sendTopic, request, clearMessages, terminate };
}
