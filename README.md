# chanx-js

Type-safe WebSocket client for [chanx](https://github.com/huynguyengl99/chanx) AsyncAPI
schemas, with topic multiplexing. Client only: the server stays in Python.

**[Documentation](https://huynguyengl99.github.io/chanx-js/)** ·
[Getting started](https://huynguyengl99.github.io/chanx-js/guide/getting-started) ·
[API reference](https://huynguyengl99.github.io/chanx-js/api/)

- **`@chanx-js/client`**: the runtime. Zero dependencies, framework-agnostic, with optional
  bindings on `@chanx-js/client/react`, `@chanx-js/client/vue`, `@chanx-js/client/svelte` and `@chanx-js/client/solid`.
- **`@chanx-js/codegen`**: the CLI that turns an AsyncAPI 3 schema into typed channel
  descriptors.

All four bindings are thin adapters over one shared controller, so buffering, filtering
and batching behave identically whichever you use.

```bash
pnpm add @chanx-js/client
pnpm add -D @chanx-js/codegen
```

## Generate

```bash
npx @chanx-js/codegen http://localhost:8000/asyncapi.json -o src/generated
```

Emits `schemas.ts` (message and payload types), `channels.ts` (descriptors, with topics
nested under the connection that carries them) and `index.ts`.

## Use

```ts
import { createClient } from '@chanx-js/client';
import { chat, topicHub } from './generated';

const client = createClient({ baseUrl: 'wss://api.example.com' });
const connection = client.connect(chat, { params: { room: 'lobby' } });

connection.on('chat_notification', (message) => {
  console.log(message.payload.message); // narrowed by `action`
});

connection.send({ action: 'chat', payload: { message: 'hello' } });

// Await the reply: it carries the request's ref, on a channel or on a topic.
const pong = await connection.request({ action: 'ping', payload: null });

const hub = client.connect(topicHub);
const room = hub.topic(topicHub.topics.roomTopic.with({ room_name: 'lobby' }));
const posted = await room.request({ action: 'post', payload: { body: 'hi' } });
```

Plain-channel `request()` needs chanx 2.11.2 or later, the first release to echo the
`ref` on replies to untopiced frames. Topic requests work on any version with topics.

### React

```tsx
import { useChannel } from '@chanx-js/client/react';

function ChatPanel() {
  const { lastMessage, status, send } = useChannel(chat, { params: { room: 'lobby' } });

  useEffect(() => {
    if (lastMessage?.action === 'chat_notification') {
      append(lastMessage.payload);
    }
  }, [lastMessage]);

  return <div>{status}</div>;
}
```

`lastMessage` is the familiar react-use-websocket shape. For a stream where dropping
frames matters, use callbacks with a coalescing window instead:

```tsx
useChannel(chat, {
  buffer: 'none',
  on: {
    agent_streaming: { batch: 'raf', handler: (batch) => appendTokens(batch) },
    agent_complete: () => setDone(true),
  },
});
```

Or `buffer: 'all'` for an accumulating `messages` array you drain with `clearMessages()`.

### Sharing a socket

Channels that carry topics share one socket between every component using them, and it
closes when the last one unmounts. Topic frames reach only the consumer that subscribed,
so sharing is safe there. A plain channel gives each component its own socket: shared, it
would be one inbox, where a reply to one component's `send()` reaches all of them.

```tsx
// Opt a plain channel in when components really want one stream:
function MessageList() {
  const { lastMessage } = useChannel(chat, { params: { room }, share: true });
}
function MessageInput() {
  const { send } = useChannel(chat, { params: { room }, share: true });
}

// Or opt a topic channel out:
useTopics(topicHub, { topics, share: false });
```

On a shared plain socket, use `request()` for private replies: they carry the request's
`ref`. Socket-level options (reconnect, heartbeat, protocols) are set by the first
consumer to open a shared socket; later joiners inherit them. `closeDelay` (default
100ms) keeps the socket up briefly after the last consumer leaves, so React StrictMode's
remount rejoins it instead of reconnecting.

### Heartbeat

On automatically for channels whose schema declares both `ping` and `pong` (codegen
marks them `heartbeat: true`), and off everywhere else. chanx has no built-in ping
handler, so a consumer that never declared one answers each ping with an `error` frame.

```ts
createClient({ heartbeat: { interval: 30_000, timeout: 10_000 } }); // tunes it; does not force it
client.connect(chat, { heartbeat: false }); // off for this connection
client.connect(legacy, { heartbeat: {} }); // force it on
```

### Closing for everyone

Because sockets are shared, `close()` only gives up one consumer's claim; the socket
stays up while anyone else holds it. To end it for all of them:

```ts
// One shared socket, for every component using it.
const { terminate } = useChannel(chat, { params: { room } });
terminate(4001, 'logged out');

// Every socket this client opened, e.g. on logout.
useChanxClient().closeAll();

// Every socket in the process, across clients.
import { terminateAllSockets } from '@chanx-js/client';
terminateAllSockets();
```

Terminated consumers see `status: 'closed'`, their pending requests reject and open
`for await` loops end. Nothing reconnects; the next `connect()`, or a remount, opens a
fresh socket. Every binding exposes `terminate`, and plain connections have
`connection.terminate()`.

### Topics

Topics multiplex over their channel's single connection, are reference counted per
resolved topic, and resubscribe after a reconnect. `with()` fills a topic's params,
checked at compile time.

```tsx
// One topic, typed from it throughout:
const { lastMessage, send } = useTopic(
  topicHub,
  topicHub.topics.roomTopic.with({ room_name: 'lobby' }),
);

// A set known only at runtime:
const { subscribed } = useTopics(topicHub, {
  topics: members.map((user) => topicHub.topics.presenceTopic.with({ user })),
});
```

### Plain JS/TS and Node

No framework needed: the runtime is the API. Three helpers make scripts read well:

```ts
const connection = client.connect(chat, { params: { room: 'lobby' } });

await connection.ready(); // fail fast on an unreachable server
const pong = await connection.request({ action: 'ping', payload: null });
const first = await connection.once('chat_notification', { timeout: 5000 });

for await (const message of connection) {
  // ends when the connection closes
  if (message.action === 'chat_notification') console.log(message.payload.message);
}
```

Sends made before the socket opens are queued and flushed on open, so `ready()` is
optional. `stream()` takes a `limit` (default 1024) and drops the oldest message when a
slow consumer falls behind, and an `AbortSignal` to stop early. Topic handles have the
same `once`, `stream` and `for await`.

Both packages are ESM only, and the types need TypeScript 5.0 or later.

**Node 22+** has a global `WebSocket`, so nothing extra is required. On Node 20,
supply one:

```ts
import WebSocket from 'ws';

const client = createClient({
  baseUrl: 'ws://localhost:8000',
  socketFactory: (url, protocols) => new WebSocket(url, protocols) as never,
});
```

### Vue

Composables returning refs. Params may be a ref, so a route change reconnects without
remounting. Cleanup registers on the effect scope.

```ts
import { chanxPlugin, useChannel } from '@chanx-js/client/vue';

app.use(chanxPlugin, { baseUrl: 'wss://api.example.com' });

const room = ref({ room: 'lobby' });
const { status, lastMessage, send } = useChannel(chat, { params: room });
```

### Svelte

Stores, so `$chat.status` works in a template. Works on Svelte 4 and 5. Inside a
component, teardown registers with `onDestroy`; outside one, call `close()`.

```svelte
<script>
  import { createChannel } from '@chanx-js/client/svelte';
  const chat = createChannel(chatChannel);
</script>

<p>{$chat.status}</p>
<button on:click={() => chat.send({ action: 'ping', payload: null })}>ping</button>
```

### Solid

Signals and accessors, cleaned up via `onCleanup` when there is an owner.

```tsx
import { createChannel } from '@chanx-js/client/solid';

const chat = createChannel(chatChannel);
return <p>{chat.status()}</p>;
```

## Reusing existing types

When payload types already exist (generated from your OpenAPI schema, say), reference
them instead of regenerating:

```bash
npx @chanx-js/codegen <schema> -o src/generated \
  --reuse-from 'src/types/backend/**/*.ts' \
  --alias 'src/=@/' \
  --reuse-strict
```

`--reuse-strict` emits compile-time assertions that each reused type still matches the
schema, because a matching _name_ does not guarantee a matching _shape_. Use `--ambient`
if your existing types are global scripts rather than modules.

## Validation

Off by default: types only, zero runtime cost. `--validation zod` emits zod schemas and
wires them into each descriptor; the runtime calls an optional hook, so zod is only ever
loaded if you opt in (add `zod` 3.25 or later to your project). Defaults to validating
outbound messages always and inbound in development only. Validation only checks:
handlers always get the message exactly as sent.

## Development

```bash
pnpm install
pnpm check              # lint, format, typecheck, test
pnpm check:conformance  # regenerate from the chanx sandbox schema, fail on drift
pnpm docs:dev           # docs site with live reload
pnpm docs:build         # the site as GitHub Pages serves it
```

See the [design notes](https://huynguyengl99.github.io/chanx-js/design) for the protocol,
the reference-counting rules, and why this does not wrap react-use-websocket.

## License

MIT
