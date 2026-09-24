# React

React 18 or later. Hooks from `@chanx-js/client/react`.

## Providing a client

Pass a client down with the provider:

```tsx
import { createClient } from '@chanx-js/client';
import { ChanxClientProvider } from '@chanx-js/client/react';

const client = createClient({ baseUrl: 'wss://api.example.com' });

root.render(
  <ChanxClientProvider value={client}>
    <App />
  </ChanxClientProvider>,
);
```

Without a provider, hooks use a default client, which `setDefaultClient({ baseUrl })` configures. `useChanxClient()` returns whichever is in effect.

## `useChannel`

```tsx
import { useChannel } from '@chanx-js/client/react';

function ChatPanel({ room }: { room: string }) {
  const { status, lastMessage, send } = useChannel(chat, { params: { room } });

  useEffect(() => {
    if (lastMessage?.action === 'chat_notification') append(lastMessage.payload);
  }, [lastMessage]);

  return (
    <button onClick={() => send({ action: 'ping', payload: null })}>{status}</button>
  );
}
```

It returns:

| Field                       | Meaning                                          |
| --------------------------- | ------------------------------------------------ |
| `status`                    | `connecting`, `open`, `reconnecting` or `closed` |
| `lastMessage`               | The newest message, for `buffer: 'latest'`       |
| `messages`, `clearMessages` | Every message, for `buffer: 'all'`               |
| `send`, `request`           | Typed from the channel's outgoing messages       |
| `terminate`                 | Close the socket for every component sharing it  |
| `connection`                | The underlying connection, once open             |

Options: everything a [connection](../guide/connections) takes, plus `enabled`, `buffer`, `only`, `on`, `onError` and `onUnhandled`; see [Delivery modes](../guide/delivery).

The connection is rebuilt only when an option that shapes it changes: `params`, `queryParams` (a refreshed token, say), `protocols`, `share` or `enabled`. An inline `on` map changes every render and does not reconnect.

## `useTopic`

```tsx
import { useTopic } from '@chanx-js/client/react';

function Room({ name }: { name: string }) {
  const { subscribed, lastMessage, send } = useTopic(
    topicHub,
    topicHub.topics.roomTopic.with({ room_name: name }),
  );
  // ...
}
```

Returns `status`, `subscribed`, `lastMessage`, `messages`, `clearMessages`, `send`, `request`, `handle` and `terminate`, all typed from the topic. A new `name` rejoins.

## `useTopics`

For a set of topics known only at runtime:

```tsx
const { subscribed, lastMessage } = useTopics(topicHub, {
  topics: members.map((user) => topicHub.topics.presenceTopic.with({ user })),
});
```

See [Topics](../guide/topics).

## Your own hooks

Wrap the bindings to give a channel your app's defaults once, instead of at every call site:

```tsx
import { useChannel, useTopic } from '@chanx-js/client/react';

import { notifications, topicHub } from './generated';

export function useNotifications() {
  const token = useAuthToken();
  return useChannel(notifications, {
    queryParams: { token },
    enabled: Boolean(token),
    buffer: 'all',
  });
}

export function useRoom(name: string) {
  return useTopic(topicHub, topicHub.topics.roomTopic.with({ room_name: name }), {
    onSubscribeError: (topic) => toast(`Cannot join ${topic}`),
  });
}
```

Types flow through unchanged: `useNotifications().messages` is still the channel's own message union.

## Enabling later

Hold a connection back until you have what it needs:

```tsx
useChannel(chat, { params: { room }, enabled: Boolean(token) });
```

While disabled, `status` is `closed` and nothing connects.

## StrictMode

Supported. The development double-mount rejoins the same socket instead of reconnecting; see [Sharing](../guide/sharing#react-strictmode).
