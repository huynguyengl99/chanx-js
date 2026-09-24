# chanx

Type-safe WebSocket client for [chanx](https://github.com/huynguyengl99/chanx) AsyncAPI
schemas, with topic multiplexing. Zero dependencies, with optional bindings for React,
Vue, Svelte and Solid, and first-class support for plain JavaScript and Node.

**[Documentation](https://huynguyengl99.github.io/chanx-js/)** ·
[Getting started](https://huynguyengl99.github.io/chanx-js/guide/getting-started) ·
[API reference](https://huynguyengl99.github.io/chanx-js/api/)

```bash
pnpm add @chanx-js/client
pnpm add -D @chanx-js/codegen
npx @chanx-js/codegen http://localhost:8000/asyncapi.json -o src/generated
```

```ts
import { createClient } from '@chanx-js/client';
import { chat } from './generated';

const client = createClient({ baseUrl: 'wss://api.example.com' });
const connection = client.connect(chat, { params: { room: 'lobby' } });

connection.on('chat_notification', (message) => console.log(message.payload.message));
connection.send({ action: 'chat', payload: { message: 'hello' } });
```

| Import                    | For                                       |
| ------------------------- | ----------------------------------------- |
| `@chanx-js/client`        | The runtime: clients, connections, topics |
| `@chanx-js/client/react`  | `useChannel`, `useTopics`                 |
| `@chanx-js/client/vue`    | Composables returning refs                |
| `@chanx-js/client/svelte` | Stores, for Svelte 4 and 5                |
| `@chanx-js/client/solid`  | Signals and accessors                     |

MIT licensed.
