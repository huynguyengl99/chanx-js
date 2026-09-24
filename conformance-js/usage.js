// @ts-check
/**
 * Plain JavaScript, with no TypeScript syntax anywhere in this file. Checked with `checkJs`,
 * so every `@ts-expect-error` below proves a JS project gets the same narrowing a TS
 * project does, purely from the emitted `.d.ts` files.
 */
import { createClient } from '@chanx-js/client';

import { chat, roomChat, topicHub } from './generated/index.js';

const client = createClient({ baseUrl: 'wss://example.test' });
const connection = client.connect(chat);

connection.send({ action: 'chat', payload: { message: 'hello' } });

// @ts-expect-error `pong` is server-to-client, so it is not a valid outgoing message.
connection.send({ action: 'pong', payload: null });

// @ts-expect-error `nope` is not an action on this channel at all.
connection.send({ action: 'nope', payload: null });

connection.on('chat_notification', (message) => {
  // Narrowed by the discriminant, so the payload is known here.
  console.log(message.payload.message);
});

// @ts-expect-error `chat_notification` carries no `missing` field.
connection.on('chat_notification', (message) => console.log(message.missing));

// An address with a param requires it.
client.connect(roomChat, { params: { room_name: 'lobby' } });

// @ts-expect-error `room_name` is required by the address `/ws/room/{room_name}`.
client.connect(roomChat, { params: {} });

// Topics resolve through the channel that owns their connection.
const hub = client.connect(topicHub);
const room = hub.topic(topicHub.topics.roomTopic.with({ room_name: 'lobby' }));
room.send({ action: 'post', payload: { body: 'hello' } });

// @ts-expect-error `posted` is inbound only.
room.send({ action: 'posted', payload: { body: 'no' } });

/** The vanilla helpers are equally typed from JavaScript. */
export async function script() {
  await connection.ready({ timeout: 5000 });

  const notification = await connection.once('chat_notification', { timeout: 5000 });
  console.log(notification.payload.message);

  for await (const message of connection) {
    if (message.action === 'chat_notification') console.log(message.payload.message);
  }
}
