# Vue

Vue 3.4 or later. Composables from `@chanx-js/client/vue`.

## Installing the plugin

```ts
import { chanxPlugin } from '@chanx-js/client/vue';

app.use(chanxPlugin, { baseUrl: 'wss://api.example.com' });
```

`chanxPlugin` accepts client options or a client from `createClient`. Without it, composables use a default client, which `setDefaultClient` configures.

## `useChannel`

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useChannel } from '@chanx-js/client/vue';

const room = ref({ room: 'lobby' });
const { status, lastMessage, send } = useChannel(chat, { params: room });
</script>

<template>
  <p>{{ status }}</p>
  <p v-if="lastMessage?.action === 'chat_notification'">
    {{ lastMessage.payload.message }}
  </p>
</template>
```

`status`, `lastMessage`, `messages` and `connection` are refs. `params` and `queryParams` may themselves be refs: changing one reconnects without remounting.

Delivery options (`buffer`, `only`, `on`) work as described in [Delivery modes](../guide/delivery).

## `useTopic`

```ts
import { computed } from 'vue';
import { useTopic } from '@chanx-js/client/vue';

const props = defineProps<{ room: string }>();
const { subscribed, lastMessage, send } = useTopic(
  topicHub,
  computed(() => topicHub.topics.roomTopic.with({ room_name: props.room })),
);
```

The topic may be a plain ref or a `computed`: a new topic rejoins. Everything is typed from that topic.

## `useTopics`

For a set of topics known only at runtime:

```ts
const { subscribed, lastMessage } = useTopics(topicHub, {
  topics: computed(() =>
    members.value.map((user) => topicHub.topics.presenceTopic.with({ user })),
  ),
});
```

`params`, `queryParams` and `topics` may be refs; a change rejoins.

## Your own composables

Wrap the bindings to give a channel your app's defaults once:

```ts
import { computed } from 'vue';
import { useChannel } from '@chanx-js/client/vue';

import { notifications } from './generated';

export function useNotifications() {
  const auth = useAuthStore();
  return useChannel(notifications, {
    queryParams: computed(() => ({ token: auth.token })),
    buffer: 'all',
  });
}
```

A new token reconnects, since `queryParams` is reactive. Types flow through unchanged.

## Cleanup

Inside a component, composables connect on mount, so server-side rendering opens no socket, and they register cleanup on the component, so unmounting releases the connection. Outside a scope, such as in a store, call the returned `close()` yourself. `terminate()` closes the socket for every consumer sharing it.
