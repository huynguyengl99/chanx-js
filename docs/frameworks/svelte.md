# Svelte

Svelte 4 or 5. Stores from `@chanx-js/client/svelte`.

## Configuring the client

```ts
import { setDefaultClient } from '@chanx-js/client/svelte';

setDefaultClient({ baseUrl: 'wss://api.example.com' });
```

Or pass `client` to an individual store. `getChanxClient()` returns the default.

## `createChannel`

The result is a store, so `$` works in templates:

```svelte
<script lang="ts">
  import { createChannel } from '@chanx-js/client/svelte';

  const channel = createChannel(chat, { params: { room: 'lobby' } });
</script>

<p>{$channel.status}</p>
{#if $channel.lastMessage?.action === 'chat_notification'}
  <p>{$channel.lastMessage.payload.message}</p>
{/if}

<button on:click={() => channel.send({ action: 'ping', payload: null })}>ping</button>
```

The store's value has `status`, `lastMessage` and `messages`. Alongside `subscribe`, it has `send`, `request`, `clearMessages`, `getConnection`, `close` and `terminate`.

Inside a component, the connection opens when the component mounts, so server-side rendering opens no socket. Outside a component it opens when the store is created. Either way it does not wait for something to read the store, so a component can send before it reads.

Options are read once. For new params, create a new store.

## `createTopic`

```ts
import { createTopic } from '@chanx-js/client/svelte';

const topic = createTopic(
  topicHub,
  topicHub.topics.roomTopic.with({ room_name: 'lobby' }),
);
// $topic.subscribed, $topic.lastMessage
topic.send({ action: 'post', payload: { body: 'hi' } });
```

Everything is typed from that one topic, and `subscribed` is a boolean.

## `createTopics`

For a set of topics known only at runtime:

```ts
import { createTopics } from '@chanx-js/client/svelte';

const topics = createTopics(topicHub, {
  topics: members.map((user) => topicHub.topics.presenceTopic.with({ user })),
});
// $topics.subscribed, $topics.lastMessage
```

## Your own stores

Wrap the bindings to give a channel your app's defaults once:

```ts
import { get } from 'svelte/store';
import { createChannel } from '@chanx-js/client/svelte';

import { notifications } from './generated';

export function createNotifications() {
  return createChannel(notifications, {
    queryParams: { token: get(authToken) },
    buffer: 'all',
  });
}
```

Call it during component initialisation to tie it to the component. Types flow through unchanged.

## Cleanup

Created inside a component, a store closes itself when the component is destroyed. Created elsewhere, such as in a module, call `close()` yourself.
