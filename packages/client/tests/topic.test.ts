import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/core/client';
import { defineChannel, defineTopic } from '../src/core/descriptor';
import { resetSockets } from '../src/core/socket';
import { FakeSocket, fakeFactory } from './fake-socket';

type Ping = { action: 'ping'; payload: null };
type Pong = { action: 'pong'; payload: null };
type Post = { action: 'post'; payload: { body: string } };
type Posted = { action: 'posted'; payload: { body: string } };

const roomTopic = defineTopic<Post, Posted>()({
  name: 'room_topic',
  pattern: 'room:{room_name}',
});

const hub = defineChannel<Ping, Pong>()({
  name: 'topic_hub',
  address: '/ws/topics',
  topics: { roomTopic },
});

function connect() {
  const client = createClient({
    baseUrl: 'ws://test.local',
    socketFactory: fakeFactory,
    closeDelay: 0,
    heartbeat: false,
    reconnectInterval: 5,
  });
  const connection = client.connect(hub);
  FakeSocket.last.accept();
  return connection;
}

/** Answer the most recent subscribe/unsubscribe so its promise settles. */
function ackLast(action: 'subscribed' | 'unsubscribed'): void {
  const frame = FakeSocket.last.lastSent;
  FakeSocket.last.receive({
    version: 1,
    topic: frame.topic,
    ref: frame.ref,
    action,
    payload: null,
  });
}

beforeEach(() => {
  resetSockets();
  FakeSocket.reset();
});

describe('subscribing', () => {
  it('sends subscribe stamped with the resolved topic', async () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    expect(handle.topic).toBe('room:lobby');

    const pending = handle.subscribe();
    expect(FakeSocket.last.lastSent).toMatchObject({
      version: 1,
      topic: 'room:lobby',
      action: 'subscribe',
    });

    ackLast('subscribed');
    await expect(pending).resolves.toMatchObject({ action: 'subscribed' });
    expect(handle.subscribed).toBe(true);
  });
});

describe('routing', () => {
  it('delivers a topic frame with the envelope stripped and passed alongside', async () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const onPosted = vi.fn();
    handle.on('posted', onPosted);

    FakeSocket.last.receive({
      version: 1,
      topic: 'room:lobby',
      seq: 7,
      action: 'posted',
      payload: { body: 'hi' },
    });

    expect(onPosted).toHaveBeenCalledWith(
      { action: 'posted', payload: { body: 'hi' } },
      { version: 1, topic: 'room:lobby', seq: 7 },
    );
  });

  it('does not leak one topic’s frames into another', () => {
    const connection = connect();
    const lobby = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const other = connection.topic(roomTopic.with({ room_name: 'other' }));

    const onLobby = vi.fn();
    const onOther = vi.fn();
    lobby.on('posted', onLobby);
    other.on('posted', onOther);

    FakeSocket.last.receive({
      version: 1,
      topic: 'room:lobby',
      action: 'posted',
      payload: { body: 'hi' },
    });

    expect(onLobby).toHaveBeenCalledOnce();
    expect(onOther).not.toHaveBeenCalled();
  });

  it('keeps channel-level frames away from topics', () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const onTopicAny = vi.fn();
    const onChannelPong = vi.fn();
    handle.onAny(onTopicAny);
    connection.on('pong', onChannelPong);

    FakeSocket.last.receive({ version: 1, action: 'pong', payload: null });

    expect(onChannelPong).toHaveBeenCalledOnce();
    expect(onTopicAny).not.toHaveBeenCalled();
  });
});

describe('reference counting', () => {
  it('shares one handle between consumers of the same topic', () => {
    const connection = connect();
    const first = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const second = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    expect(first).toBe(second);
  });

  it('unsubscribes only once the last consumer releases', async () => {
    const connection = connect();
    const first = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const second = connection.topic(roomTopic.with({ room_name: 'lobby' }));

    const pending = first.subscribe();
    ackLast('subscribed');
    await pending;

    first.release();
    expect(FakeSocket.last.lastSent.action).not.toBe('unsubscribe');

    second.release();
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'unsubscribe',
    });
  });

  it('leaves a surviving consumer’s handlers working after a partial release', async () => {
    const connection = connect();
    const first = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const second = connection.topic(roomTopic.with({ room_name: 'lobby' }));

    const onSecond = vi.fn();
    second.on('posted', onSecond);
    first.release();

    FakeSocket.last.receive({
      version: 1,
      topic: 'room:lobby',
      action: 'posted',
      payload: { body: 'still here' },
    });

    expect(onSecond).toHaveBeenCalledOnce();
  });
});

describe('reconnection', () => {
  it('resubscribes every subscribed topic when the socket reopens', async () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));

    const pending = handle.subscribe();
    ackLast('subscribed');
    await pending;

    const before = FakeSocket.instances.length;
    FakeSocket.last.close(1006, 'dropped');
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(before));

    FakeSocket.last.accept();
    await vi.waitFor(() =>
      expect(FakeSocket.last.sent).toContainEqual(
        expect.objectContaining({ topic: 'room:lobby', action: 'subscribe' }),
      ),
    );
  });
});

describe('topic streams', () => {
  const ended = (stream: AsyncIterator<unknown>) =>
    Promise.race([
      stream.next().then((result) => result.done),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50)),
    ]);

  it('ends when the connection closes', async () => {
    const connection = connect();
    const stream = connection.topic(roomTopic.with({ room_name: 'lobby' })).stream();

    connection.close();

    expect(await ended(stream)).toBe(true);
  });

  it('ends when the socket is terminated', async () => {
    const connection = connect();
    const stream = connection.topic(roomTopic.with({ room_name: 'lobby' })).stream();

    connection.terminate();

    expect(await ended(stream)).toBe(true);
  });

  it('ends when the last consumer releases the topic', async () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const stream = handle.stream();

    handle.release();

    expect(await ended(stream)).toBe(true);
  });
});

describe('failed resubscribe', () => {
  it('marks the topic unsubscribed and reports it', async () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const pending = handle.subscribe();
    ackLast('subscribed');
    await pending;
    const failed = vi.fn();
    handle.onSubscribeError(failed);

    FakeSocket.last.close(1006, 'dropped');
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    FakeSocket.last.accept();
    await vi.waitFor(() => expect(FakeSocket.last.sent).toHaveLength(1));
    const resubscribe = FakeSocket.last.lastSent;
    FakeSocket.last.receive({
      version: 1,
      topic: resubscribe.topic,
      ref: resubscribe.ref,
      action: 'error',
      payload: { detail: 'no longer allowed' },
    });

    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(handle.subscribed).toBe(false);
  });
});

describe('sequence numbers', () => {
  it('passes each frame’s seq, so a replay overlapping live events can be ordered', () => {
    const connection = connect();
    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const seqs: Array<number | undefined> = [];
    handle.on('posted', (_message, { seq }) => seqs.push(seq));

    const frame = (seq?: number) => ({
      version: 1,
      topic: 'room:lobby',
      ...(seq === undefined ? {} : { seq }),
      action: 'posted',
      payload: { body: 'x' },
    });
    // Replay of the run so far (1, 2), overlapping the live stream (2, 3), then an
    // event outside any run.
    for (const seq of [1, 2, 2, 3, undefined]) FakeSocket.last.receive(frame(seq));

    expect(seqs).toEqual([1, 2, 2, 3, undefined]);
  });
});
