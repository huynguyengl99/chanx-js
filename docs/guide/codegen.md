# Code generation

`@chanx-js/codegen` reads the AsyncAPI 3 document a chanx server publishes and writes typed channel descriptors for the runtime.

```bash
npx @chanx-js/codegen <url-or-path> -o src/generated
```

The schema can be a URL or a local file, in JSON or YAML.

## Options

| Option                | Default         | Effect                                                            |
| --------------------- | --------------- | ----------------------------------------------------------------- |
| `-o, --out <dir>`     | `src/generated` | Output directory                                                  |
| `--emit <target>`     | `ts`            | `ts` for TypeScript, `js` for JavaScript plus `.d.ts`             |
| `--validation <mode>` | `none`          | `zod` also emits zod schemas and wires them into the descriptors  |
| `--reuse-from <glob>` |                 | Reference existing types instead of generating them (repeatable)  |
| `--alias <mapping>`   |                 | Rewrite import paths, e.g. `src/=@/` (repeatable)                 |
| `--reuse-strict`      |                 | Emit compile-time checks that reused types still match the schema |
| `--ambient`           |                 | Treat reused types as global scripts: skip them, emit no imports  |
| `--no-format`         |                 | Skip prettier (it is used when installed)                         |

## What it generates

For each channel, a descriptor and the two message unions, named from the client's side:

```ts
export type ChatToServer = ChatMessage | PingMessage;
export type ChatToClient = ChatNotificationMessage | PongMessage;

export const chat = defineChannel<ChatToServer, ChatToClient>()({
  name: 'chat',
  address: '/ws/chat/{room}/',
  heartbeat: true,
});
```

A channel carrying topics nests them under the connection they share:

```ts
export const topicHub = defineChannel<TopicHubToServer, TopicHubToClient>()({
  name: 'topic_hub',
  address: '/ws/topics',
  topics: {
    roomTopic: defineTopic<TopicHubRoomTopicToServer, TopicHubRoomTopicToClient>()({
      name: 'room_topic',
      pattern: 'room:{room_name}',
    }),
  },
});
```

When a consumer declares only topics, it has no plain channel. Its topics still get a connection named after the consumer, carrying no messages of its own: `agent.topics.threadTopic`. A topic served on its own route is emitted as a connection that carries itself as its only topic.

### The `action` discriminant

chanx gives every message's `action` a constant _and_ a default, so the schema leaves it out of `required`. A naive generator emits `action?: 'ping'`, which admits `undefined` into the union and silently disables exhaustiveness checks. `@chanx-js/codegen` treats a constant as always present, so a `switch` over a channel's messages stays exhaustive.

### Heartbeat detection

chanx has no built-in ping handler. A channel is marked `heartbeat: true` only when its schema declares both sending `ping` and receiving `pong`, and the runtime only runs a heartbeat on marked channels. See [Connections](./connections#heartbeat).

## JavaScript output

`--emit js` splits each module into a runtime `.js` file and a `.d.ts`:

| File                      | Contains                                             |
| ------------------------- | ---------------------------------------------------- |
| `channels.js`             | The descriptors, with no TypeScript syntax           |
| `channels.d.ts`           | The same descriptors with their full generic types   |
| `schemas.d.ts`            | Message types: declarations only, nothing at runtime |
| `index.js` / `index.d.ts` | Re-exports                                           |

A plain JavaScript project imports `./generated/index.js` and still gets narrowing, address-param checks and topic typing from its editor, or from `checkJs`.

## Validation

Off by default: only types, with no runtime cost. `--validation zod` also emits `schemas.zod.ts` and attaches validators to each descriptor. The runtime only ever calls an optional hook, so zod is loaded only when you opt in. The generated file imports `zod`, so add it to your project (`pnpm add zod`, version 3.25 or later).

Validation is configured per client or per connection:

```ts
createClient({ validate: { outbound: true, inbound: false } });
```

The default validates outbound messages always (cheap, and it catches real bugs) and inbound messages only in development, where a token stream's cost does not matter. Development means `process.env.NODE_ENV` is not `production`, which Vite, webpack and Next.js all set at build time.

Validation checks a message and never changes it: your handlers get the message exactly as the server sent it, whether validation ran or not. An outbound message that fails throws from `send()`, since that is a bug at the call site. An inbound one that fails is reported (see [Receiving](./connections#receiving)) and not delivered.

## Reusing existing types

Payload types often already exist, generated from the server's OpenAPI schema for its REST endpoints. Reference them instead of generating duplicates:

```bash
npx @chanx-js/codegen <schema> -o src/generated \
  --reuse-from 'src/types/backend/**/*.ts' \
  --alias 'src/=@/'
```

Any type in the schema whose name matches an exported declaration in those files is imported rather than generated:

```ts
import type { PostPayload } from '@/types/backend/rooms';
```

The scan reads the TypeScript AST, so `export type`, `interface` and indented declarations are all found. Only exported declarations count, since importing anything else would not compile, and files inside the output directory are ignored.

With `--validation zod`, a reused type is not regenerated, so its validator is permissive. A reused message still checks its `action`.

If your existing types are _global scripts_ (bare `type X = ...` files with no imports or exports), add `--ambient`. Matching types are simply not emitted, and the global declaration wins.

### Checking reused types still match

A matching _name_ does not guarantee a matching _shape_: two schema generators can disagree on nullability, date formats, or required fields. `--reuse-strict` emits a `reuse-check` file that fails to compile when they drift:

```ts
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;

export type CheckPostPayload = Assert<
  MutuallyAssignable<PostPayload, GeneratedPostPayload>
>;
```

It is purely type-level, so it works as a `.d.ts` under `--emit js` too, and runs in the typecheck you already have.

## Your own hooks

Codegen emits framework-neutral descriptors, not hooks: a descriptor already carries the address, params, topics and message types, so `useChannel(notifications)` is fully typed as it is. The hooks worth having carry your app's defaults (a token, when to connect, how to buffer), which a generator cannot know. Write them as thin wrappers; see [React](../frameworks/react#your-own-hooks), [Vue](../frameworks/vue#your-own-composables), [Svelte](../frameworks/svelte#your-own-stores) and [Solid](../frameworks/solid#your-own-primitives).

## Name clashes

Names come from the schema by case conversion, so `chat-room` and `chat_room` both become `ChatRoom`. When two channels, topics or schemas would produce the same identifier, generation stops with an error naming both, instead of writing code that does not compile. Rename one on the server.

## Keeping it current

Commit the generated files and regenerate in CI; a `git diff --exit-code` afterwards fails the build when the server's schema has changed without the client being regenerated.
