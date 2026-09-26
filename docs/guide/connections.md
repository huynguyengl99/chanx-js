# Connections

## The client

A client holds the defaults for one server. Create one and share it:

```ts
import { createClient } from '@chanx-js/client';

const client = createClient({ baseUrl: 'wss://api.example.com' });
```

| Option              | Default                      | Effect                                                                   |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `baseUrl`           | the page's origin            | Server origin; relative addresses resolve against it                     |
| `share`             | topic channels only          | Share one socket per URL and subprotocols; see [Sharing](./sharing)      |
| `reconnectAttempts` | `10`                         | Give up after this many consecutive failures                             |
| `reconnectInterval` | backoff, capped at 30s       | A fixed delay, or `(attempt) => ms`                                      |
| `shouldReconnect`   | always                       | `(closeEvent) => boolean`                                                |
| `retryOnError`      | `false`                      | Close and reconnect on a socket error                                    |
| `onReconnectStop`   |                              | Called when reconnecting gives up                                        |
| `heartbeat`         | automatic                    | See [Heartbeat](#heartbeat)                                              |
| `queryParams`       |                              | Appended to every URL; per-connection values merge over these            |
| `protocols`         |                              | WebSocket subprotocols                                                   |
| `maxQueuedFrames`   | `100`                        | Frames buffered before the socket opens; past this the oldest is dropped |
| `closeDelay`        | `100` ms                     | Grace period before an unused socket closes                              |
| `validate`          | outbound always, inbound dev | See [Validation](./codegen#validation)                                   |
| `socketFactory`     | global `WebSocket`           | Supply a WebSocket, e.g. from `ws` on older Node                         |

Every option except `baseUrl` can also be passed per connection. Address `params` are URL-encoded, so a value never adds a path segment or a query.

## Connecting

```ts
const connection = client.connect(chat, { params: { room: 'lobby' } });
```

`params` fills the `{placeholders}` in the channel's address, and its type is derived from that address: a missing or misspelt param is a compile error.

Frames sent before the socket opens are queued and flushed on open, so there is no need to wait. When a script should fail fast on an unreachable server instead:

```ts
await connection.ready({ timeout: 5000 });
```

## Receiving

```ts
connection.on('chat_notification', (message) => {
  message.payload.message; // narrowed to ChatNotificationMessage
});

connection.onAny((message) => {}); // every message
connection.onUnhandled((message) => {}); // messages no `on` handler claimed
connection.onError((error) => {}); // the server's `error` frames
```

Each returns a function that removes the handler. Handlers also receive the frame's envelope, `(message, envelope)`, for the routing fields a message leaves out: `seq`, `ref` and `topic`.

A handler that throws does not stop the others, or other consumers of a shared socket, from receiving the message. The error is reported the way a throwing DOM event listener's is: through `reportError` in a browser (the console and `window.onerror`), and as an uncaught exception in Node.

chanx's own protocol frames (`subscribed`, `unsubscribed`, `complete`, `event_complete`, `group_complete` and `error`) are handled by the runtime and never reach `on` or `onAny`.

To await a single message, or consume them in a loop:

```ts
const first = await connection.once('chat_notification', { timeout: 5000 });

for await (const message of connection) {
  // ends when the connection closes
}
```

`connection.stream({ limit, signal })` is the configurable form of the loop. It holds at most `limit` messages (default 1024) while your loop body is busy, dropping the oldest, and stops when the signal aborts or the socket is terminated.

## Sending and requests

```ts
connection.send({ action: 'chat', payload: { message: 'hello' } });

const reply = await connection.request({ action: 'ping', payload: null });
```

`request()` stamps the frame with a `ref` and resolves with the reply carrying the same `ref`. It rejects on the server's `error` reply, on timeout (10 seconds by default), or when the connection closes first. Any later frame carrying the same `ref`, such as a reply that arrives after its request timed out, is delivered to the handlers like any other message.

::: warning chanx 2.11.2 or later
chanx echoes the `ref` on replies to plain (untopiced) frames from 2.11.2. Against an older server, `request()` on a channel times out; requests on a [topic](./topics) work on any version with topics.
:::

## Reconnecting

When the socket drops unexpectedly, it reconnects with backoff (1s, 2s, 4s, capped at 30s) until `reconnectAttempts` is exhausted. A consumer that joins a socket which gave up starts it again with a fresh set of attempts. `status` moves through `connecting`, `open`, `reconnecting` and `closed`:

```ts
connection.status;
connection.onStatus((status) => {});
```

Subscribed topics resubscribe automatically once the socket reopens.

## Heartbeat

A heartbeat pings on an interval and reconnects when nothing comes back. It runs automatically on channels whose schema declares ping and pong (codegen marks them `heartbeat: true`) and is off everywhere else, because a chanx consumer without a ping handler answers each ping with an `error` frame.

```ts
createClient({ heartbeat: { interval: 30_000, timeout: 10_000 } }); // tunes it; does not force it
client.connect(chat, { heartbeat: false }); // off for this connection
client.connect(legacy, { heartbeat: {} }); // force it on
```

A per-connection setting always wins. Any inbound frame counts as proof of life, not only a pong. The socket reconnects when `timeout` passes after a ping with nothing received, however it compares with `interval`.

## Closing

```ts
connection.close(); // give up this consumer's claim on the socket
connection.terminate(); // close the socket for every consumer sharing it
```

The difference matters when a socket is shared; see [Sharing and closing](./sharing).
