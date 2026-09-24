import { createEffect, createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChannel, createTopic, createTopics, setDefaultClient } from '../src/solid';
import {
  accept,
  ackLast,
  FakeSocket,
  hub,
  makeClient,
  receive,
  resetHarness,
  roomTopic,
} from './harness';

beforeEach(() => {
  resetHarness();
  setDefaultClient(makeClient());
});

describe('createChannel', () => {
  it('exposes status as an accessor that tracks the socket', () => {
    createRoot((dispose) => {
      const channel = createChannel(hub);
      expect(channel.status()).toBe('connecting');

      accept();
      expect(channel.status()).toBe('open');
      dispose();
    });
  });

  it('drives an effect when a message arrives', async () => {
    const seen: string[] = [];
    const dispose = createRoot((disposeRoot) => {
      const channel = createChannel(hub);
      accept();
      createEffect(() => {
        const message = channel.lastMessage();
        if (message) seen.push(message.action);
      });
      return disposeRoot;
    });

    receive({ version: 1, action: 'pong', payload: null });
    await vi.waitFor(() => expect(seen).toEqual(['pong']));
    dispose();
  });

  it('accumulates when buffer is all', () => {
    createRoot((dispose) => {
      const channel = createChannel(hub, { buffer: 'all' });
      accept();
      receive({ version: 1, action: 'pong', payload: null });
      receive({ version: 1, action: 'posted', payload: { body: 'x' } });

      expect(channel.messages()).toHaveLength(2);
      dispose();
    });
  });

  it('sends through the socket', () => {
    createRoot((dispose) => {
      const channel = createChannel(hub);
      accept();
      channel.send({ action: 'ping', payload: null });

      expect(FakeSocket.last.lastSent).toMatchObject({ action: 'ping' });
      dispose();
    });
  });

  it('closes the socket when the owner disposes', async () => {
    createRoot((dispose) => {
      createChannel(hub);
      accept();
      dispose();
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeSocket.last.readyState).toBe(3);
  });

  it('does not connect when disabled', () => {
    createRoot((dispose) => {
      const channel = createChannel(hub, { enabled: false });
      expect(FakeSocket.instances).toHaveLength(0);
      expect(channel.status()).toBe('closed');
      dispose();
    });
  });

  it('runs on handlers', () => {
    createRoot((dispose) => {
      const onPong = vi.fn();
      createChannel(hub, { buffer: 'none', on: { pong: onPong } });
      accept();
      receive({ version: 1, action: 'pong', payload: null });

      expect(onPong).toHaveBeenCalledOnce();
      dispose();
    });
  });
});

describe('createTopics', () => {
  it('subscribes and reports the confirmation', async () => {
    let dispose!: () => void;
    const topics = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createTopics(hub, { topics: [roomTopic.with({ room_name: 'lobby' })] });
    });

    accept();
    ackLast();

    await vi.waitFor(() => expect(topics.subscribed()).toEqual(['room:lobby']));
    dispose();
  });

  it('tags messages with their topic', () => {
    createRoot((dispose) => {
      const topics = createTopics(hub, {
        topics: [roomTopic.with({ room_name: 'lobby' })],
        buffer: 'all',
      });
      accept();
      ackLast();
      receive({
        version: 1,
        topic: 'room:lobby',
        action: 'posted',
        payload: { body: 'hi' },
      });

      expect(topics.messages()[0]).toMatchObject({
        topic: 'room:lobby',
        action: 'posted',
      });
      dispose();
    });
  });

  it('unsubscribes when the owner disposes', async () => {
    let dispose!: () => void;
    const topics = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createTopics(hub, { topics: [roomTopic.with({ room_name: 'lobby' })] });
    });

    accept();
    ackLast();
    // The unsubscribe only goes out for a topic that finished subscribing.
    await vi.waitFor(() => expect(topics.subscribed()).toHaveLength(1));

    dispose();
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'unsubscribe',
    });
  });
});

describe('createTopic', () => {
  it('joins one topic, reports it as a boolean and sends on it', async () => {
    let dispose!: () => void;
    const topic = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createTopic(hub, roomTopic.with({ room_name: 'lobby' }));
    });
    accept();
    ackLast();

    await vi.waitFor(() => expect(topic.subscribed()).toBe(true));
    topic.send({ action: 'post', payload: { body: 'hi' } });
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'post',
    });
    dispose();
  });
});
