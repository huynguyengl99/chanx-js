/**
 * Compiled, not run. Every construct here is one the generated code must support:
 * if narrowing, params or topic typing regress, `pnpm typecheck` fails.
 */
import { createClient, defineChannel, defineTopic } from '@chanx-js/client';
import { useChannel, useTopic, useTopics } from '@chanx-js/client/react';

import { chat, roomChat, topicHub } from './generated';
import type { ChatToClient } from './generated';

const client = createClient({ baseUrl: 'wss://example.test' });

// A channel with no address params needs no `params`.
const chatConnection = client.connect(chat);

chatConnection.send({ action: 'chat', payload: { message: 'hi' } });

// @ts-expect-error `pong` is server-to-client, so it is not a valid outgoing message.
chatConnection.send({ action: 'pong', payload: null });

// @ts-expect-error `nope` is not an action on this channel at all.
chatConnection.send({ action: 'nope', payload: null });

chatConnection.on('chat_notification', (message) => {
  // Narrowed by the discriminant, so the payload is known here.
  console.log(message.payload.message);
});

// @ts-expect-error `chat_notification` carries no `missing` field.
chatConnection.on('chat_notification', (message) => console.log(message.missing));

/** A switch over the union stays exhaustive: a new action breaks this on purpose. */
export function handle(message: ChatToClient): string {
  switch (message.action) {
    case 'chat_notification':
      return message.payload.message;
    case 'extra_passthrough':
      return 'passthrough';
    case 'extra_response':
      return 'response';
    case 'pong':
      return 'pong';
    case 'user_joined_notification':
      return 'joined';
    case 'user_left_notification':
      return 'left';
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

// An address with a param requires it, and rejects an unknown one.
client.connect(roomChat, { params: { room_name: 'lobby' } });

// @ts-expect-error `room_name` is required by the address `/ws/room/{room_name}`.
client.connect(roomChat, { params: {} });

// Topics are reached through the channel that owns their connection.
const hub = client.connect(topicHub);
const room = hub.topic(topicHub.topics.roomTopic.with({ room_name: 'lobby' }));
room.send({ action: 'post', payload: { body: 'hello' } });
room.on('posted', (message) => console.log(message.payload.body));
// The envelope rides alongside: `seq` orders a topic's events.
room.on('posted', (_message, { seq }) => {
  const order: number | undefined = seq;
  void order;
});

// @ts-expect-error `posted` is inbound only.
room.send({ action: 'posted', payload: { body: 'no' } });

// Topic params are checked against the pattern, like a channel's address params.
topicHub.topics.presenceTopic.with({ user: 'alice' });
// @ts-expect-error `room_name` is misspelled.
topicHub.topics.roomTopic.with({ room_nam: 'lobby' });
// @ts-expect-error the pattern `room:{room_name}` needs `room_name`.
topicHub.topics.roomTopic.with();

/** The no-framework path: await, iterate, and stay narrowed throughout. */
export async function script() {
  await chatConnection.ready({ timeout: 5000 });

  const pong = await chatConnection.request({ action: 'ping', payload: null });
  void pong;

  const notification = await chatConnection.once('chat_notification', { timeout: 5000 });
  // `once` narrows to the single message type, so the payload is known.
  console.log(notification.payload.message);

  // @ts-expect-error `nope` is not an action this channel receives.
  await chatConnection.once('nope');

  const controller = new AbortController();
  for await (const message of chatConnection.stream({ signal: controller.signal })) {
    if (message.action === 'chat_notification') console.log(message.payload.message);
  }

  // The connection itself is async-iterable.
  for await (const message of chatConnection) {
    if (message.action === 'pong') break;
  }

  for await (const message of room) {
    if (message.action === 'posted') console.log(message.payload.body);
  }
}

export function ChatPanel() {
  // The familiar react-use-websocket shape: latest message in state.
  const { lastMessage, status, send } = useChannel(chat);
  if (lastMessage?.action === 'chat_notification') {
    console.log(lastMessage.payload.message);
  }
  send({ action: 'ping', payload: null });
  return status;
}

export function BatchedPanel() {
  // Callbacks, with a coalescing window on the hot action.
  const { status } = useChannel(chat, {
    buffer: 'none',
    on: {
      chat_notification: {
        batch: 'raf',
        handler: (messages) => console.log(messages.length),
      },
      pong: () => console.log('pong'),
    },
  });
  return status;
}

export function RoomPanel() {
  const { subscribed, sendTopic } = useTopics(topicHub, {
    topics: [topicHub.topics.roomTopic.with({ room_name: 'lobby' })],
    on: { posted: (message) => console.log(message.action) },
  });
  sendTopic('room:lobby', { action: 'post', payload: { body: 'hi' } });
  return subscribed;
}

export function SingleRoom() {
  // One topic: everything typed from it, no union to narrow and no topic name to pass.
  const { lastMessage, send, subscribed } = useTopic(
    topicHub,
    topicHub.topics.roomTopic.with({ room_name: 'lobby' }),
  );
  if (lastMessage?.action === 'posted')
    console.log(lastMessage.payload.body, lastMessage.topic);
  send({ action: 'post', payload: { body: 'hi' } });
  // @ts-expect-error `posted` is inbound only.
  send({ action: 'posted', payload: { body: 'no' } });
  return subscribed;
}

export function PresenceList({ users }: { users: string[] }) {
  // A set that varies at runtime, which one hook per topic cannot do.
  const { lastMessage } = useTopics(topicHub, {
    topics: users.map((user) => topicHub.topics.presenceTopic.with({ user })),
  });
  // Only presence topics are joined, so only their messages can arrive.
  const action: 'presence_changed' | undefined = lastMessage?.action;
  return action;
}

export function MixedTopics() {
  const { lastMessage } = useTopics(topicHub, {
    topics: [
      topicHub.topics.roomTopic.with({ room_name: 'lobby' }),
      topicHub.topics.presenceTopic.with({ user: 'alice' }),
    ],
    on: {
      posted: (message) => console.log(message.payload.body),
      presence_changed: (message) => console.log(message.payload.user),
    },
  });
  if (lastMessage?.action === 'presence_changed') console.log(lastMessage.payload.user);

  useTopics(topicHub, {
    topics: [topicHub.topics.roomTopic.with({ room_name: 'lobby' })],
    // @ts-expect-error `chat_notification` arrives on no joined topic.
    on: { chat_notification: () => undefined },
  });
  return lastMessage;
}

export function WrongChannel() {
  // @ts-expect-error `chat` carries no topics, so no topic ref belongs to it.
  return useTopic(chat, topicHub.topics.roomTopic.with({ room_name: 'lobby' }));
}

type Say = { action: 'say'; payload: { text: string } };
type Said = { action: 'said'; payload: { text: string } };
type Poke = { action: 'poke'; payload: null };
type Poked = { action: 'poked'; payload: { by: string } };

const mixed = defineChannel<never, never>()({
  name: 'mixed',
  address: '/ws/mixed',
  topics: {
    talk: defineTopic<Say, Said>()({ name: 'talk', pattern: 'talk:{room}' }),
    poke: defineTopic<Poke, Poked>()({ name: 'poke', pattern: 'poke:{user}' }),
  },
});

export function TwoTopicsWithOutgoingMessages() {
  // Both topics send, so the joined set must infer as a union, not the first element.
  const { lastMessage, sendTopic } = useTopics(mixed, {
    topics: [
      mixed.topics.talk.with({ room: 'a' }),
      mixed.topics.poke.with({ user: 'b' }),
    ],
    on: {
      said: (message) => console.log(message.payload.text),
      poked: (message) => console.log(message.payload.by),
    },
  });
  sendTopic('poke:b', { action: 'poke', payload: null });
  if (lastMessage?.action === 'poked') console.log(lastMessage.payload.by);
  return lastMessage;
}
