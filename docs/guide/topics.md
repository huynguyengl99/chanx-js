# Topics

A chanx topic is a stream addressed by name, such as `room:lobby` or `presence:alice`, that travels over its channel's single connection. One socket can carry many topics.

## Joining a topic

Topics are reached through the channel whose connection carries them. Codegen nests them there:

```ts
const hub = client.connect(topicHub);
const room = hub.topic(topicHub.topics.roomTopic.with({ room_name: 'lobby' }));

await room.subscribe();

room.on('posted', (message) => {
  message.payload.body; // typed from the topic's own messages
});
```

`with()` fills the topic's pattern (`room:{room_name}`) and returns a ref to join. Its params are checked at compile time just like an address: a missing or misspelled one does not compile. Every topic API takes a ref: `connection.topic()`, `useTopic` and `useTopics`.

A handle has the same helpers as a connection: `on`, `onAny`, `once`, `stream`, `for await`, `send` and `request`:

```ts
room.send({ action: 'post', payload: { body: 'hello' } });

const reply = await room.request({ action: 'post', payload: { body: 'hi' } });
```

A topic request resolves with the reply carrying its `ref`, on any chanx version with topics.

## In a component

`useTopic` (React, Vue) and `createTopic` (Svelte, Solid) join one topic for the component's lifetime:

```tsx
function Room({ name }: { name: string }) {
  const { subscribed, lastMessage, send } = useTopic(
    topicHub,
    topicHub.topics.roomTopic.with({ room_name: name }),
    { onSubscribeError: (topic, error) => console.warn(topic, error) },
  );

  if (lastMessage?.action === 'posted') lastMessage.payload.body; // the topic's own types
  send({ action: 'post', payload: { body: 'hi' } }); // sent on room:<name>
}
```

- Everything is typed from that one topic: no union to narrow, no topic name to pass.
- `subscribed` is true once the server confirms, and false again if the socket is terminated or a resubscribe is rejected.
- A new ref (here, a new `name`) leaves the old topic and joins the new one; re-rendering with the same topic does nothing.
- Only the topic's messages arrive here. A topic from another channel does not compile.

`onSubscribeError` catches rejected subscriptions, most often an `authorize` check on the server, including a resubscribe after a reconnect.

### Several or dynamic topics

When the set of topics is only known at runtime, such as presence for every member of a list, one hook per topic is not possible. `useTopics` (React, Vue) and `createTopics` (Svelte, Solid) join a whole set:

```tsx
const { subscribed, lastMessage, sendTopic } = useTopics(topicHub, {
  topics: members.map((user) => topicHub.topics.presenceTopic.with({ user })),
  on: { presence_changed: (message) => setOnline(message.payload.user) },
});
```

- `lastMessage` and `messages` are typed as any joined topic's messages, each with a `topic` field saying which stream it came from. Narrow by `action`.
- `subscribed` lists the topics the server has confirmed.
- `sendTopic(topic, message)` sends on a joined topic by its resolved name. For a send typed to one topic, use the handle from `handles`, or `useTopic`.
- Changing the list rejoins; the same list on a re-render does not.

## Ordering with `seq`

A topic may number its events on the envelope, as chanx-kit's ag_ui kit does per run, so a client joining mid-run can apply a replay that overlaps live events without duplicates. Handlers get it as the second argument, and buffered messages carry it next to `topic`:

```ts
handle.on('ag_ui_event', (message, { seq }) => apply(seq, message.payload));

const { lastMessage } = useTopic(hub, hub.topics.agUi.with({ thread }));
lastMessage?.seq;
```

## Leaving

| How                    | Effect on this consumer | Effect on others sharing the socket |
| ---------------------- | ----------------------- | ----------------------------------- |
| `handle.unsubscribe()` | stops receiving         | none; they keep receiving           |
| `handle.release()`     | stops receiving         | none                                |
| `connection.close()`   | stops receiving         | none                                |
| `terminate()`          | closed                  | closed too, by design               |

The server is told to unsubscribe only when the last consumer holding the topic on that socket leaves. `unsubscribe()` keeps the handle, so it can `subscribe()` again; `release()` drops this consumer's claim on the handle. Components using `useTopics` release on unmount.

## After a reconnect

Every topic that was subscribed resubscribes automatically when the socket reopens. There is nothing to do. If the server rejects a resubscribe (say permissions changed while the socket was down), the topic drops out of `subscribed`, and `handle.onSubscribeError` and the bindings' `onSubscribeError` report it.

A topic's `stream()` ends when the last consumer releases the topic, the connection closes, or the socket is terminated.

## State pushed on join

A topic can push state when a client joins, from its server-side `on_subscribe`. chanx-kit's `room_chat` sends the recent backlog, and `presence` sends the member list. chanx sends nothing there by default.

One case to know about: if two components on the **same shared socket** subscribe to the same topic, only the first receives that initial state. The server answers the second subscribe as a duplicate and does not run `on_subscribe` again. When that matters, have the joining component ask for state explicitly with `request()`, so only the asker receives the reply. The chanx-kit kits provide a request message for this.
