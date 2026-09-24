# Sharing and closing

## When sockets are shared

Whether consumers of the same channel and params share one socket depends on the channel. Connections opened with different `protocols` never share, since subprotocols often carry credentials.

| Channel        | Default                 | Why                                                                                                                                                               |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Carries topics | shared                  | Topic frames reach only the consumer that subscribed, and requests are matched by `ref`, so each consumer sees only its own. Multiplexing is the point of topics. |
| Plain          | one socket per consumer | A shared plain socket is one inbox: when one consumer uses `send()`, the reply reaches every consumer on the socket.                                              |

This is the split the established libraries make too: Socket.IO reuses one connection for its multiplexed namespaces, while react-use-websocket defaults `share` to `false` for raw sockets.

## Sharing a plain channel

When several components genuinely want the same stream, opt in, like react-use-websocket's `share: true`:

```tsx
// Both components use one connection.
function MessageList({ room }: { room: string }) {
  const { lastMessage } = useChannel(chat, { params: { room }, share: true });
}

function MessageInput({ room }: { room: string }) {
  const { send } = useChannel(chat, { params: { room }, share: true });
}
```

Every consumer of a shared plain socket sees every message, so use `request()` for anything expecting a private reply: the reply carries the request's `ref` and reaches only the consumer that asked (chanx 2.11.2 or later).

`share` can be set client-wide, `createClient({ share: true })`, or per connection, which always wins. A topic channel opts out the same way, with `share: false`.

## Consumers sharing a socket

- A request's reply reaches only the consumer that made it.
- One unsubscribing from a topic, or unmounting, never unsubscribes the others; see [Topics](./topics#leaving).
- Socket options (reconnect, heartbeat, protocols) belong to the socket, so the **first** consumer to open a shared socket sets them. Later consumers joining it inherit them.

## Closing

Because a socket may be shared, "close" has two meanings:

| Call                                   | Scope                            | Reconnects? |
| -------------------------------------- | -------------------------------- | ----------- |
| `connection.close()`, or unmounting    | this consumer's claim only       | n/a         |
| `connection.terminate()` / `terminate` | one socket, every consumer on it | no          |
| `client.closeAll()`                    | every socket this client opened  | no          |
| `terminateAllSockets()`                | every socket in the process      | no          |

Closing a claim leaves the socket up while anyone else holds it. To end it for everyone, for example on logout:

```ts
// One shared socket, for every component using it
const { terminate } = useChannel(chat, { params: { room } });
terminate(4001, 'logged out');

// Every socket this client opened
useChanxClient().closeAll();

// Every socket, across clients
import { terminateAllSockets } from '@chanx-js/client';
terminateAllSockets();
```

Consumers of a terminated socket see `status: 'closed'`. Their pending requests reject, their `for await` loops end, and a topics binding's `subscribed` list empties. Nothing reconnects; the next `connect()`, or a remount, opens a fresh socket.

Terminating sends no `unsubscribe` frames: the server leaves every topic when the socket disconnects.

## React StrictMode

StrictMode unmounts and immediately remounts every component in development. `closeDelay` (default 100ms) keeps a socket up briefly after its last consumer leaves, so the remount rejoins it rather than reconnecting.

A private socket (a plain channel by default, or any channel with `share: false`) has nothing to rejoin, so under StrictMode it opens a short-lived socket before settling on one. This only happens in development, and nothing leaks.
