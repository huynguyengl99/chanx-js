# Plain JS and Node

No framework is needed: the runtime is the API.

```ts
import { createClient } from '@chanx-js/client';

import { chat } from './generated';

const client = createClient({ baseUrl: 'wss://api.example.com' });
const connection = client.connect(chat, { params: { room: 'lobby' } });

await connection.ready(); // fail fast on an unreachable server
const pong = await connection.request({ action: 'ping', payload: null });
const first = await connection.once('chat_notification', { timeout: 5000 });

for await (const message of connection) {
  if (message.action === 'chat_notification') console.log(message.payload.message);
}
```

The `for await` loop ends when the connection closes. `connection.stream({ limit, signal })` is the configurable form: it holds at most `limit` messages (default 1024) while the loop body is busy, dropping the oldest, and stops when the signal aborts. Topic handles have the same `once`, `stream` and `for await`.

## Node

Node 22 and later ship a global `WebSocket`, so nothing extra is needed. On Node 20, supply one:

```ts
import WebSocket from 'ws';

const client = createClient({
  baseUrl: 'ws://localhost:8000',
  socketFactory: (url, protocols) => new WebSocket(url, protocols) as never,
});
```

## Plain JavaScript

Generate JavaScript output and import it directly:

```bash
npx @chanx-js/codegen <schema> -o src/generated --emit js
```

```js
// @ts-check
import { createClient } from '@chanx-js/client';

import { chat } from './generated/index.js';
```

The emitted `.d.ts` files give a JavaScript project the same narrowing and checks as a TypeScript one, in the editor or under `checkJs`.

## Closing

A script should close what it opened, or the process stays alive:

```ts
connection.close();
client.closeAll(); // every socket this client opened
```
