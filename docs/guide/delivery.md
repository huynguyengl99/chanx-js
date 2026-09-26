# Delivery modes

How messages reach a component is a choice, set with `buffer` and `on`. They behave the same in every binding.

| Mode               | Shape                          | Drops messages? | For                            |
| ------------------ | ------------------------------ | --------------- | ------------------------------ |
| `buffer: 'latest'` | `lastMessage`                  | yes             | the default; effect + switch   |
| `buffer: 'all'`    | `messages` + `clearMessages()` | no              | processing every message       |
| `buffer: 'none'`   | nothing in state               | n/a             | when `on` handlers do the work |
| `on: { ... }`      | callbacks, no re-render        | no              | hot streams                    |

## `lastMessage`

The familiar react-use-websocket shape: the newest message, in state:

```tsx
const { lastMessage } = useChannel(chat, { params: { room } });

useEffect(() => {
  if (lastMessage?.action === 'chat_notification') append(lastMessage.payload);
}, [lastMessage]);
```

It **drops messages**: when two arrive before the component re-renders, only the second is seen. That is invisible for occasional replies, and data loss for a token stream.

## Accumulating with `buffer: 'all'`

Nothing is dropped; drain the buffer once you have handled it:

```tsx
const { messages, clearMessages } = useChannel(chat, { params: { room }, buffer: 'all' });

useEffect(() => {
  if (messages.length === 0) return;
  messages.forEach(handle);
  clearMessages();
}, [messages]);
```

## Callbacks with `on`

Handlers run as messages arrive, without putting anything in state, so a busy stream does not re-render the component per message:

```tsx
useChannel(chat, {
  params: { room },
  buffer: 'none',
  on: {
    chat_notification: (message) => append(message.payload),
    agent_complete: () => setDone(true),
  },
});
```

Handlers may close over current state: they are refreshed every render without reconnecting.

### Batching a hot action

For a token stream, coalesce an action's messages and handle them once per frame:

```tsx
on: {
  agent_streaming: { batch: 'raf', handler: (batch) => appendTokens(batch) },
}
```

`batch: 'raf'` delivers once per animation frame; a number delivers once per that many milliseconds.

## Mixing them

A batched handler also receives the envelopes, `(messages, envelopes)`, with `envelopes[i]` belonging to `messages[i]`.

Modes combine: `on` for the one streaming action, `lastMessage` for everything else. `only` restricts which actions reach the buffer, without affecting `on`:

```tsx
useChannel(chat, {
  params: { room },
  only: ['chat_notification', 'user_joined'],
  on: { agent_streaming: { batch: 'raf', handler: appendTokens } },
});
```

Server errors have their own callback, `onError`. `onUnhandled` receives messages nothing took: no `on` handler, and kept out of the buffer by `only` or `buffer: 'none'`. It catches actions you forgot to handle.
