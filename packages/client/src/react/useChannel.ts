import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { ChannelConnection, RequestOptions } from '../core/connection';
import type { ControllerOptions } from '../core/controller';
import { connectionKey, createChannelController } from '../core/controller';
import type {
  AddressOf,
  ChannelDescriptor,
  ToClientOf,
  ToServerOf,
} from '../core/descriptor';
import type { ChanxMessage } from '../core/protocol';
import type { SocketStatus } from '../core/socket';
import { useChanxClient } from './context';

export type { BufferMode } from '../core/controller';

export type UseChannelOptions<
  Address extends string,
  ToClient extends ChanxMessage,
> = ControllerOptions<Address, ToClient>;

export interface UseChannelResult<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
> {
  status: SocketStatus;
  lastMessage: ToClient | null;
  messages: ToClient[];
  clearMessages: () => void;
  send: (message: ToServer) => void;
  request: (message: ToServer, options?: RequestOptions) => Promise<ChanxMessage>;
  connection: ChannelConnection<ToServer, ToClient> | null;
  /** Close the socket for every component sharing it, not just this one. */
  terminate: (code?: number, reason?: string) => void;
}

/**
 * Open (or join) a channel's connection for the lifetime of the component.
 *
 * On a channel carrying topics, components with the same params share one socket, which
 * closes when the last of them unmounts. A plain channel gets a socket per component
 * unless `share: true`. Changing `params`, `queryParams`, `protocols`, `share` or
 * `enabled` reconnects; changing handlers does not.
 */
export function useChannel<D extends ChannelDescriptor<any, any, any, any>>(
  descriptor: D,
  options: UseChannelOptions<AddressOf<D>, ToClientOf<D>> = {},
): UseChannelResult<ToServerOf<D>, ToClientOf<D>> {
  const client = useChanxClient();

  const key = connectionKey(options);

  // `options` is read but deliberately not a dependency: the connection must survive a
  // changed `on` map, which the effect below syncs instead. `key` covers every option
  // that shapes the connection.
  const controller = useMemo(
    () => createChannelController(client, descriptor, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, descriptor, key],
  );

  useEffect(() => {
    controller.setOptions(options as ControllerOptions<string, ToClientOf<D>>);
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

  return {
    status: snapshot.status,
    lastMessage: snapshot.lastMessage,
    messages: snapshot.messages,
    clearMessages,
    send,
    request,
    connection: controller.getConnection(),
    terminate,
  };
}
