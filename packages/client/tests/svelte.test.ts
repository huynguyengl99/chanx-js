import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSnapshot } from '../src/core/controller';
import {
  createChannel,
  createTopic,
  createTopics,
  setDefaultClient,
} from '../src/svelte';
import type { ChannelToClient } from './harness';
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
  it('exposes the snapshot through the store contract', () => {
    const channel = createChannel(hub);
    expect(get(channel).status).toBe('connecting');

    accept();
    expect(get(channel).status).toBe('open');
    channel.close();
  });

  it('notifies subscribers as messages arrive', () => {
    const channel = createChannel(hub);
    accept();

    const seen: Array<ChannelSnapshot<ChannelToClient>> = [];
    const unsubscribe = channel.subscribe((snapshot) => seen.push(snapshot));

    receive({ version: 1, action: 'pong', payload: null });

    // One immediate call on subscribe, then one per message.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.lastMessage?.action).toBe('pong');

    unsubscribe();
    channel.close();
  });

  it('accumulates when buffer is all', () => {
    const channel = createChannel(hub, { buffer: 'all' });
    accept();
    receive({ version: 1, action: 'pong', payload: null });
    receive({ version: 1, action: 'posted', payload: { body: 'x' } });

    expect(get(channel).messages).toHaveLength(2);
    channel.close();
  });

  it('drains with clearMessages', () => {
    const channel = createChannel(hub, { buffer: 'all' });
    accept();
    receive({ version: 1, action: 'pong', payload: null });
    channel.clearMessages();

    expect(get(channel).messages).toHaveLength(0);
    channel.close();
  });

  it('sends through the socket', () => {
    const channel = createChannel(hub);
    accept();
    channel.send({ action: 'ping', payload: null });

    expect(FakeSocket.last.lastSent).toMatchObject({ action: 'ping' });
    channel.close();
  });

  it('holds the connection open with no store subscriber', () => {
    // A component may send before anything reads the store, so the connection must
    // not be tied to subscription.
    const channel = createChannel(hub);
    accept();
    expect(FakeSocket.last.readyState).toBe(1);

    channel.send({ action: 'ping', payload: null });
    expect(FakeSocket.last.sent).toHaveLength(1);
    channel.close();
  });

  it('closes the socket on close', async () => {
    const channel = createChannel(hub);
    accept();
    channel.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(FakeSocket.last.readyState).toBe(3);
  });

  it('does not connect when disabled', () => {
    const channel = createChannel(hub, { enabled: false });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(get(channel).status).toBe('closed');
    channel.close();
  });

  it('runs on handlers', () => {
    const onPong = vi.fn();
    const channel = createChannel(hub, { buffer: 'none', on: { pong: onPong } });
    accept();
    receive({ version: 1, action: 'pong', payload: null });

    expect(onPong).toHaveBeenCalledOnce();
    channel.close();
  });
});

describe('createTopics', () => {
  it('subscribes and reports the confirmation', async () => {
    const topics = createTopics(hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    accept();
    ackLast();

    await vi.waitFor(() => expect(get(topics).subscribed).toEqual(['room:lobby']));
    topics.close();
  });

  it('tags messages with their topic', async () => {
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

    expect(get(topics).messages[0]).toMatchObject({
      topic: 'room:lobby',
      action: 'posted',
    });
    topics.close();
  });

  it('sends on a joined topic', async () => {
    const topics = createTopics(hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    accept();
    ackLast();
    await vi.waitFor(() => expect(get(topics).subscribed).toHaveLength(1));

    topics.sendTopic('room:lobby', { action: 'post', payload: { body: 'hi' } });
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'post',
    });
    topics.close();
  });

  it('unsubscribes on close', async () => {
    const topics = createTopics(hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    accept();
    ackLast();
    await vi.waitFor(() => expect(get(topics).subscribed).toHaveLength(1));

    topics.close();
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'unsubscribe',
    });
  });
});

describe('createTopic', () => {
  it('joins one topic, reports it as a boolean and sends on it', async () => {
    const topic = createTopic(hub, roomTopic.with({ room_name: 'lobby' }));
    accept();
    ackLast();

    await vi.waitFor(() => expect(get(topic).subscribed).toBe(true));
    topic.send({ action: 'post', payload: { body: 'hi' } });
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'post',
    });
    topic.close();
  });
});
