# Solid

Solid 1.8 or later. Signals from `@chanx-js/client/solid`.

## Configuring the client

```ts
import { setDefaultClient } from '@chanx-js/client/solid';

setDefaultClient({ baseUrl: 'wss://api.example.com' });
```

Or pass `client` to an individual call. `getChanxClient()` returns the default.

## `createChannel`

```tsx
import { Show } from 'solid-js';
import { createChannel } from '@chanx-js/client/solid';

function ChatPanel() {
  const channel = createChannel(chat, { params: { room: 'lobby' } });

  return (
    <>
      <p>{channel.status()}</p>
      <Show when={channel.lastMessage()?.action === 'chat_notification'}>
        <p>new message</p>
      </Show>
      <button onClick={() => channel.send({ action: 'ping', payload: null })}>
        ping
      </button>
    </>
  );
}
```

`status`, `lastMessage`, `messages` and `connection` are accessors, so they track in effects and JSX. The result also has `send`, `request`, `clearMessages`, `close` and `terminate`.

## `createTopic`

```ts
import { createTopic } from '@chanx-js/client/solid';

const topic = createTopic(
  topicHub,
  topicHub.topics.roomTopic.with({ room_name: 'lobby' }),
);
// topic.subscribed(), topic.lastMessage()
topic.send({ action: 'post', payload: { body: 'hi' } });
```

Everything is typed from that one topic, and `subscribed` is a boolean.

## `createTopics`

For a set of topics known only at runtime:

```ts
import { createTopics } from '@chanx-js/client/solid';

const topics = createTopics(topicHub, {
  topics: members.map((user) => topicHub.topics.presenceTopic.with({ user })),
});
// topics.subscribed(), topics.lastMessage()
```

## Your own primitives

Wrap the bindings to give a channel your app's defaults once:

```ts
import { createChannel } from '@chanx-js/client/solid';

import { notifications } from './generated';

export function createNotifications() {
  return createChannel(notifications, {
    queryParams: { token: authToken() },
    buffer: 'all',
  });
}
```

Call it inside a component so cleanup is tied to it. Types flow through unchanged.

## Cleanup

With an owner (inside a component or `createRoot`), cleanup registers with `onCleanup`. Without one, call `close()` yourself. Nothing connects during server-side rendering.

Options are read once. For new params, create it again, for example under a keyed `<Show>`.
