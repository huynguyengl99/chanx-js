import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createChannelController,
  createTopicController,
  createTopicsController,
} from '../src/core/controller';
import { defineTopic } from '../src/core/descriptor';
import type { Ping, Posted } from './harness';
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

beforeEach(resetHarness);

function start(options: Parameters<typeof createChannelController>[2] = {}) {
  const controller = createChannelController(makeClient(), hub, options);
  controller.start();
  accept();
  return controller;
}

describe('buffer: latest', () => {
  it('publishes the newest message', () => {
    const controller = start();
    receive({ version: 1, action: 'pong', payload: null });
    expect(controller.getSnapshot().lastMessage).toEqual({
      action: 'pong',
      payload: null,
    });
  });

  it('keeps only the newest when two arrive in a tick', () => {
    const controller = start();
    receive({ version: 1, action: 'posted', payload: { body: 'one' } });
    receive({ version: 1, action: 'posted', payload: { body: 'two' } });

    const { lastMessage, messages } = controller.getSnapshot();
    expect((lastMessage as Posted).payload.body).toBe('two');
    // This is the documented trade-off of `latest`: the first frame is gone.
    expect(messages).toHaveLength(0);
  });

  it('notifies subscribers on each message', () => {
    const controller = start();
    const listener = vi.fn();
    controller.subscribe(listener);

    receive({ version: 1, action: 'pong', payload: null });
    receive({ version: 1, action: 'pong', payload: null });

    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('buffer: all', () => {
  it('keeps every message in order', () => {
    const controller = start({ buffer: 'all' });
    receive({ version: 1, action: 'posted', payload: { body: 'one' } });
    receive({ version: 1, action: 'posted', payload: { body: 'two' } });

    const bodies = controller
      .getSnapshot()
      .messages.map((m) => (m as Posted).payload.body);
    expect(bodies).toEqual(['one', 'two']);
  });

  it('drains on clearMessages', () => {
    const controller = start({ buffer: 'all' });
    receive({ version: 1, action: 'pong', payload: null });
    controller.clearMessages();
    expect(controller.getSnapshot().messages).toHaveLength(0);
  });
});

describe('buffer: none', () => {
  it('publishes no message state', () => {
    const controller = start({ buffer: 'none' });
    receive({ version: 1, action: 'pong', payload: null });

    const snapshot = controller.getSnapshot();
    expect(snapshot.lastMessage).toBeNull();
    expect(snapshot.messages).toHaveLength(0);
  });

  it('still runs the on handlers', () => {
    const onPong = vi.fn();
    start({ buffer: 'none', on: { pong: onPong } });
    receive({ version: 1, action: 'pong', payload: null });
    expect(onPong).toHaveBeenCalledOnce();
  });
});

describe('only filter', () => {
  it('keeps unlisted actions out of the buffer', () => {
    const controller = start({ buffer: 'all', only: ['pong'] });
    receive({ version: 1, action: 'posted', payload: { body: 'ignored' } });
    receive({ version: 1, action: 'pong', payload: null });

    const actions = controller.getSnapshot().messages.map((m) => m.action);
    expect(actions).toEqual(['pong']);
  });

  it('does not affect on handlers', () => {
    const onPosted = vi.fn();
    start({ buffer: 'all', only: ['pong'], on: { posted: onPosted } });
    receive({ version: 1, action: 'posted', payload: { body: 'x' } });
    expect(onPosted).toHaveBeenCalledOnce();
  });
});

describe('onUnhandled', () => {
  it('fires for a message kept out of the buffer with no handler', () => {
    const onUnhandled = vi.fn();
    start({ only: ['posted'], onUnhandled });

    receive({ version: 1, action: 'pong', payload: null });

    expect(onUnhandled).toHaveBeenCalledWith(
      { action: 'pong', payload: null },
      { version: 1 },
    );
  });

  it('fires for every message without a handler when buffer is none', () => {
    const onUnhandled = vi.fn();
    start({ buffer: 'none', on: { posted: vi.fn() }, onUnhandled });

    receive({ version: 1, action: 'pong', payload: null });
    receive({ version: 1, action: 'posted', payload: { body: 'x' } });

    expect(onUnhandled).toHaveBeenCalledOnce();
  });

  it('stays quiet for a buffered message', () => {
    const onUnhandled = vi.fn();
    start({ onUnhandled });

    receive({ version: 1, action: 'pong', payload: null });

    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe('on handlers', () => {
  it('routes by action with the envelope stripped and passed alongside', () => {
    const onPosted = vi.fn();
    start({ on: { posted: onPosted } });
    receive({ version: 1, seq: 4, action: 'posted', payload: { body: 'hi' } });
    expect(onPosted).toHaveBeenCalledWith(
      { action: 'posted', payload: { body: 'hi' } },
      { version: 1, seq: 4 },
    );
  });

  it('coalesces a batched action into one call', async () => {
    const handler = vi.fn();
    start({ on: { posted: { batch: 1, handler } } });

    receive({ version: 1, seq: 1, action: 'posted', payload: { body: 'a' } });
    receive({ version: 1, seq: 2, action: 'posted', payload: { body: 'b' } });
    receive({ version: 1, seq: 3, action: 'posted', payload: { body: 'c' } });

    expect(handler).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const [messages, envelopes] = handler.mock.calls[0] ?? [];
    expect(messages).toHaveLength(3);
    expect(envelopes.map((envelope: { seq: number }) => envelope.seq)).toEqual([1, 2, 3]);
  });

  it('picks up handlers replaced through setOptions', () => {
    const first = vi.fn();
    const second = vi.fn();
    const controller = start({ on: { pong: first } });

    controller.setOptions({ on: { pong: second } });
    receive({ version: 1, action: 'pong', payload: null });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('lifecycle', () => {
  it('reports the resolved url', () => {
    const controller = createChannelController(makeClient(), hub, {});
    expect(controller.url).toBe('ws://test.local/ws/topics');
  });

  it('stays closed and opens nothing when disabled', () => {
    const controller = createChannelController(makeClient(), hub, { enabled: false });
    controller.start();
    expect(controller.url).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(controller.getSnapshot().status).toBe('closed');
  });

  it('publishes the status of an already-open shared socket', () => {
    const client = makeClient();
    const first = createChannelController(client, hub, {});
    first.start();
    accept();

    const second = createChannelController(client, hub, {});
    second.start();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(second.getSnapshot().status).toBe('open');
  });

  it('delivers nothing after stop', () => {
    const onPong = vi.fn();
    const controller = start({ on: { pong: onPong } });
    controller.stop();
    receive({ version: 1, action: 'pong', payload: null });
    expect(onPong).not.toHaveBeenCalled();
  });

  it('is safe to stop twice', () => {
    const controller = start();
    controller.stop();
    expect(() => controller.stop()).not.toThrow();
  });
});

describe('sending', () => {
  it('rejects a request made before the connection exists', async () => {
    const controller = createChannelController(makeClient(), hub, {});
    await expect(
      controller.request({ action: 'ping', payload: null } as Ping),
    ).rejects.toThrow(/not connected/);
  });
});

describe('topics controller', () => {
  it('subscribes on start and tracks the confirmation', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    controller.start();
    accept();
    ackLast();

    await vi.waitFor(() =>
      expect(controller.getSnapshot().subscribed).toEqual(['room:lobby']),
    );
    expect(Object.keys(controller.getSnapshot().handles)).toEqual(['room:lobby']);
  });

  it('tags buffered messages with their topic', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
      buffer: 'all',
    });
    controller.start();
    accept();
    ackLast();

    receive({
      version: 1,
      topic: 'room:lobby',
      action: 'posted',
      payload: { body: 'hi' },
    });

    const [message] = controller.getSnapshot().messages;
    expect(message).toMatchObject({ action: 'posted', topic: 'room:lobby' });
    expect(message).not.toHaveProperty('seq');
  });

  it('carries a frame’s seq on the buffered message', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    controller.start();
    accept();
    ackLast();

    receive({
      version: 1,
      topic: 'room:lobby',
      seq: 5,
      action: 'posted',
      payload: { body: 'hi' },
    });

    expect(controller.getSnapshot().lastMessage).toEqual({
      action: 'posted',
      payload: { body: 'hi' },
      topic: 'room:lobby',
      seq: 5,
    });
  });

  it('reports a rejected subscription', async () => {
    const onSubscribeError = vi.fn();
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'secret' })],
      onSubscribeError,
    });
    controller.start();
    accept();

    const frame = FakeSocket.last.lastSent;
    receive({
      version: 1,
      topic: frame.topic,
      ref: frame.ref,
      action: 'error',
      payload: { reason: 'unauthorized' },
    });

    await vi.waitFor(() => expect(onSubscribeError).toHaveBeenCalledOnce());
    expect(onSubscribeError.mock.calls[0]?.[0]).toBe('room:secret');
  });

  it('reports a subscription rejected on resubscribe after a reconnect', async () => {
    const onSubscribeError = vi.fn();
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
      onSubscribeError,
    });
    controller.start();
    accept();
    ackLast();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().subscribed).toEqual(['room:lobby']),
    );

    FakeSocket.last.close(1006);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    accept();
    await vi.waitFor(() => expect(FakeSocket.last.sent).toHaveLength(1));
    const frame = FakeSocket.last.lastSent;
    receive({
      version: 1,
      topic: frame.topic,
      ref: frame.ref,
      action: 'error',
      payload: null,
    });

    await vi.waitFor(() => expect(onSubscribeError).toHaveBeenCalledOnce());
    expect(controller.getSnapshot().subscribed).toEqual([]);
  });

  it('unsubscribes and clears handles on stop', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    controller.start();
    accept();
    ackLast();
    await vi.waitFor(() => expect(controller.getSnapshot().subscribed).toHaveLength(1));

    controller.stop();

    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'unsubscribe',
    });
    expect(controller.getSnapshot().handles).toEqual({});
  });

  it('clears the subscribed list when the socket is terminated', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    controller.start();
    accept();
    ackLast();
    await vi.waitFor(() => expect(controller.getSnapshot().subscribed).toHaveLength(1));

    controller.terminate();

    expect(controller.getSnapshot().status).toBe('closed');
    expect(controller.getSnapshot().subscribed).toEqual([]);
  });

  it('sends no unsubscribe frames when terminating', async () => {
    // The server runs on_unsubscribe and leaves every group on disconnect; explicit
    // frames would only race the close and draw replies to a socket going away.
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    controller.start();
    accept();
    ackLast();
    await vi.waitFor(() => expect(controller.getSnapshot().subscribed).toHaveLength(1));
    const sentBefore = FakeSocket.last.sent.length;

    controller.terminate();
    controller.stop();

    expect(FakeSocket.last.sent).toHaveLength(sentBefore);
  });

  it('reflects an explicit unsubscribe in the subscribed list', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    controller.start();
    accept();
    ackLast();
    await vi.waitFor(() => expect(controller.getSnapshot().subscribed).toHaveLength(1));

    const pending = controller.getSnapshot().handles['room:lobby']?.unsubscribe();
    ackLast('unsubscribed');
    await pending;

    expect(controller.getSnapshot().subscribed).toEqual([]);
  });

  it('exposes a stable key for the topic set', () => {
    const keyFor = (room: string) =>
      createTopicsController(makeClient(), hub, {
        topics: [roomTopic.with({ room_name: room })],
      }).topicKey;
    expect(keyFor('lobby')).toBe(keyFor('lobby'));
    expect(keyFor('lobby')).not.toBe(keyFor('kitchen'));
    // Separators inside values cannot make two different sets collide.
    expect(keyFor('a:b|c')).not.toBe(keyFor('a'));
  });
});

describe('channel messages alongside topics', () => {
  it('keeps a channel-level frame out of the topic buffer', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
      buffer: 'all',
    });
    controller.start();
    accept();
    ackLast();

    receive({ version: 1, action: 'pong', payload: null });

    expect(controller.getSnapshot().messages).toHaveLength(0);
  });
});

describe('topic refs', () => {
  it('resolves the topic string and keeps the params', () => {
    const ref = roomTopic.with({ room_name: 'lobby' });
    expect(ref.topic).toBe('room:lobby');
    expect(ref.params).toEqual({ room_name: 'lobby' });
    expect(ref.descriptor).toBe(roomTopic);
  });

  it('needs no params for a pattern without placeholders', () => {
    const announcements = defineTopic<Ping, Posted>()({
      name: 'announcements',
      pattern: 'announcements',
    });
    expect(announcements.with().topic).toBe('announcements');
  });

  it('joins a topic listed twice once, and releases it fully on stop', async () => {
    const controller = createTopicsController(makeClient(), hub, {
      topics: [
        roomTopic.with({ room_name: 'lobby' }),
        roomTopic.with({ room_name: 'lobby' }),
      ],
    });
    controller.start();
    accept();
    ackLast();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().subscribed).toEqual(['room:lobby']),
    );

    controller.stop();

    const actions = FakeSocket.last.sent.map((frame) => frame.action);
    expect(actions).toEqual(['subscribe', 'unsubscribe']);
  });
});

describe('single topic controller', () => {
  const lobby = roomTopic.with({ room_name: 'lobby' });

  function startTopic() {
    const controller = createTopicController(makeClient(), hub, lobby);
    controller.start();
    accept();
    return controller;
  }

  it('reports the subscription as a boolean', async () => {
    const controller = startTopic();
    expect(controller.getSnapshot().subscribed).toBe(false);

    ackLast();

    await vi.waitFor(() => expect(controller.getSnapshot().subscribed).toBe(true));
  });

  it('sends on the topic without naming it', () => {
    const controller = startTopic();

    controller.send({ action: 'post', payload: { body: 'hi' } });

    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'post',
    });
  });

  it('requests on the topic and resolves the matching reply', async () => {
    const controller = startTopic();

    const reply = controller.request({ action: 'post', payload: { body: 'hi' } });
    const frame = FakeSocket.last.lastSent;
    receive({
      version: 1,
      topic: 'room:lobby',
      ref: frame.ref,
      action: 'posted',
      payload: { body: 'hi' },
    });

    await expect(reply).resolves.toEqual({ action: 'posted', payload: { body: 'hi' } });
  });

  it('rejects a request before the topic is joined', async () => {
    const controller = createTopicController(makeClient(), hub, lobby);
    await expect(
      controller.request({ action: 'post', payload: { body: 'x' } }),
    ).rejects.toThrow('Topic "room:lobby" is not joined');
  });

  it('buffers the topic’s messages and ignores the channel’s own', () => {
    const controller = startTopic();

    receive({ version: 1, action: 'pong', payload: null });
    receive({
      version: 1,
      topic: 'room:lobby',
      action: 'posted',
      payload: { body: 'hi' },
    });

    expect(controller.getSnapshot().lastMessage).toEqual({
      action: 'posted',
      payload: { body: 'hi' },
      topic: 'room:lobby',
    });
  });

  it('exposes the handle while joined', () => {
    const controller = startTopic();
    expect(controller.getHandle()?.topic).toBe('room:lobby');

    controller.stop();

    expect(controller.getHandle()).toBeNull();
  });
});
