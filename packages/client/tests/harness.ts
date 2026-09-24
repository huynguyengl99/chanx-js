import { createClient } from '../src/core/client';
import { defineChannel, defineTopic } from '../src/core/descriptor';
import { resetSockets } from '../src/core/socket';
import { FakeSocket, fakeFactory } from './fake-socket';

export type Ping = { action: 'ping'; payload: null };
export type Post = { action: 'post'; payload: { body: string } };
export type Pong = { action: 'pong'; payload: null };
export type Posted = { action: 'posted'; payload: { body: string } };
export type ChannelToClient = Pong | Posted;

export const roomTopic = defineTopic<Post, Posted>()({
  name: 'room_topic',
  pattern: 'room:{room_name}',
});

export const hub = defineChannel<Ping | Post, ChannelToClient>()({
  name: 'topic_hub',
  address: '/ws/topics',
  topics: { roomTopic },
});

export const chat = defineChannel<Ping, Pong>()({
  name: 'chat',
  address: '/ws/chat/{room}/',
});

export function makeClient() {
  return createClient({
    baseUrl: 'ws://test.local',
    socketFactory: fakeFactory,
    closeDelay: 0,
    heartbeat: false,
    reconnectInterval: 5,
  });
}

/** Reset the module-global socket registry between tests. */
export function resetHarness(): void {
  resetSockets();
  FakeSocket.reset();
}

/** Open the socket the last connect created. */
export function accept(): void {
  FakeSocket.last.accept();
}

export function receive(frame: object): void {
  FakeSocket.last.receive(frame);
}

/** Answer the most recent subscribe/unsubscribe so its promise settles. */
export function ackLast(action: 'subscribed' | 'unsubscribed' = 'subscribed'): void {
  const frame = FakeSocket.last.lastSent;
  FakeSocket.last.receive({
    version: 1,
    topic: frame.topic,
    ref: frame.ref,
    action,
    payload: null,
  });
}

export { FakeSocket };
