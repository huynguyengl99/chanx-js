import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { RequestOptions } from '../core/connection';
import type { TopicControllerOptions, TopicSnapshot } from '../core/controller';
import { connectionKey, createTopicController } from '../core/controller';
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
import { useChanxClient } from './context';

export type UseTopicOptions<
  Address extends string,
  Ref extends TopicRef,
> = TopicControllerOptions<Address, Ref>;

export interface UseTopicResult<Ref extends TopicRef> extends TopicSnapshot<Ref> {
  clearMessages: () => void;
  /** Send on the topic. */
  send: (message: ToServerOf<Ref>) => void;
  /** Send on the topic and wait for the reply carrying the same `ref`. */
  request: (message: ToServerOf<Ref>, options?: RequestOptions) => Promise<ChanxMessage>;
  /** The topic's handle while joined. */
  handle: TopicHandle<ToServerOf<Ref>, ToClientOf<Ref>> | null;
  /** Close the socket for every component sharing it, not just this one. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Join one topic for the lifetime of the component:
 *
 * ```ts
 * const { lastMessage, send } = useTopic(hub, hub.topics.roomTopic.with({ room_name }));
 * ```
 *
 * Everything is typed from that topic: `lastMessage` is one of its messages and `send`
 * takes its outgoing ones. A new ref (say `room_name` changed) rejoins; the same topic
 * on a re-render does not.
 */
export function useTopic<
  D extends ChannelDescriptor<any, any, any, any>,
  Ref extends TopicRefOf<D>,
>(
  descriptor: D,
  topic: Ref,
  options: UseTopicOptions<AddressOf<D>, Ref> = {},
): UseTopicResult<Ref> {
  const client = useChanxClient();
  const key = connectionKey(options);

  const controller = useMemo(
    () => createTopicController<D, Ref>(client, descriptor, topic, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, descriptor, key, topic.topic],
  );

  useEffect(() => {
    controller.setOptions(options as TopicControllerOptions<string, Ref>);
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
    (message: ToServerOf<Ref>) => controller.send(message),
    [controller],
  );
  const request = useCallback(
    (message: ToServerOf<Ref>, requestOptions?: RequestOptions) =>
      controller.request(message, requestOptions),
    [controller],
  );
  const clearMessages = useCallback(() => controller.clearMessages(), [controller]);
  const terminate = useCallback(
    (code?: number, reason?: string) => controller.terminate(code, reason),
    [controller],
  );

  return {
    ...snapshot,
    send,
    request,
    clearMessages,
    terminate,
    handle: controller.getHandle(),
  };
}
