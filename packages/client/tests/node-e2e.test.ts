import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/core/client';
import { defineChannel, defineTopic } from '../src/core/descriptor';
import { ENVELOPE_VERSION } from '../src/core/protocol';
import { resetSockets } from '../src/core/socket';
import { FakeServer } from './fake-server';

type Ping = { action: 'ping'; payload: null };
type Post = { action: 'post'; payload: { body: string } };
type Pong = { action: 'pong'; payload: null };
type Posted = { action: 'posted'; payload: { body: string } };

const roomTopic = defineTopic<Post, Posted>()({
  name: 'room_topic',
  pattern: 'room:{room_name}',
});

const hub = defineChannel<Ping | Post, Pong | Posted>()({
  name: 'topic_hub',
  address: '/ws/topics',
  topics: { roomTopic },
  // Declares ping/pong, as codegen marks any channel whose schema has both.
  heartbeat: true,
});

const quiet = defineChannel<Ping, Pong>()({
  name: 'quiet',
  address: '/ws/quiet',
});

let server: FakeServer;

beforeEach(async () => {
  resetSockets();
  server = await FakeServer.start();
});

afterEach(async () => {
  await server.stop();
});

/** No socketFactory: this exercises Node's own global WebSocket. */
function connect(extra: Record<string, unknown> = {}) {
  const client = createClient({
    baseUrl: server.url,
    heartbeat: false,
    closeDelay: 0,
    ...extra,
  });
  return client.connect(hub);
}

describe('node, over a real socket', () => {
  it('uses the global WebSocket with no factory supplied', async () => {
    expect(typeof WebSocket).toBe('function');

    const connection = connect();
    await connection.ready({ timeout: 2000 });

    expect(connection.status).toBe('open');
    connection.close();
  });

  it('round-trips a plain send through the envelope', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const pong = connection.once('pong', { timeout: 2000 });
    connection.send({ action: 'ping', payload: null });

    await expect(pong).resolves.toEqual({ action: 'pong', payload: null });
    expect(server.received[0]).toMatchObject({
      version: ENVELOPE_VERSION,
      action: 'ping',
    });
    connection.close();
  });

  it('round-trips a plain-channel request by its ref', async () => {
    // Needs chanx 2.11.2+, which echoes the ref on replies to untopiced frames.
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const reply = await connection.request({ action: 'ping', payload: null });

    expect(reply).toEqual({ action: 'pong', payload: null });
    expect(server.received[0]).toMatchObject({ action: 'ping', ref: expect.any(String) });
    connection.close();
  });

  it('queues a send made before the socket opens', async () => {
    const connection = connect();
    // Deliberately no `ready()`: the frame must be buffered and flushed on open.
    connection.send({ action: 'ping', payload: null });

    const pong = await connection.once('pong', { timeout: 2000 });
    expect(pong.action).toBe('pong');
    connection.close();
  });

  it('awaits a specific action with once()', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const pending = connection.once('posted', { timeout: 2000 });
    server.push({ action: 'posted', payload: { body: 'pushed' } });

    await expect(pending).resolves.toMatchObject({ payload: { body: 'pushed' } });
    connection.close();
  });

  it('times out once() rather than hanging', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    await expect(connection.once('posted', { timeout: 50 })).rejects.toThrow(/Timed out/);
    connection.close();
  });

  it('iterates messages with for await', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const seen: string[] = [];
    const stream = connection.stream();

    server.push({ action: 'posted', payload: { body: 'one' } });
    server.push({ action: 'posted', payload: { body: 'two' } });

    for await (const message of stream) {
      if (message.action === 'posted') seen.push(message.payload.body);
      if (seen.length === 2) break;
    }

    expect(seen).toEqual(['one', 'two']);
    connection.close();
  });

  it('ends an open stream when the connection closes', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const stream = connection.stream();
    const drained = (async () => {
      const seen: string[] = [];
      for await (const message of stream) seen.push(message.action);
      return seen;
    })();

    server.push({ action: 'posted', payload: { body: 'one' } });
    // Give the frame a turn to arrive before tearing down.
    await new Promise((resolve) => setTimeout(resolve, 50));
    connection.close();

    await expect(drained).resolves.toEqual(['posted']);
  });

  it('subscribes to a topic and receives a push addressed to it', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const room = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const confirmation = await room.subscribe({ timeout: 2000 });
    expect(confirmation).toMatchObject({ action: 'subscribed' });

    const pending = room.once('posted', { timeout: 2000 });
    server.push({ topic: 'room:lobby', action: 'posted', payload: { body: 'hello' } });

    await expect(pending).resolves.toMatchObject({ payload: { body: 'hello' } });
    connection.close();
  });

  it('round-trips a request on a topic', async () => {
    const connection = connect();
    await connection.ready({ timeout: 2000 });

    const room = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    await room.subscribe({ timeout: 2000 });

    const reply = await room.request({ action: 'post', payload: { body: 'hi' } });
    expect(reply).toMatchObject({ action: 'posted', payload: { body: 'hi' } });

    const sent = server.received.find((frame) => frame.action === 'post');
    expect(sent).toMatchObject({ topic: 'room:lobby', version: ENVELOPE_VERSION });
    connection.close();
  });

  it('reconnects and resubscribes after the server drops the socket', async () => {
    const connection = connect({ reconnectInterval: 20 });
    await connection.ready({ timeout: 2000 });

    const room = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    await room.subscribe({ timeout: 2000 });
    expect(server.connections).toBe(1);

    server.dropClients();

    await vi.waitFor(() => expect(server.connections).toBe(2), { timeout: 3000 });
    // The resubscribe must go out on the new socket, unprompted.
    await vi.waitFor(
      () =>
        expect(
          server.received.filter((frame) => frame.action === 'subscribe'),
        ).toHaveLength(2),
      { timeout: 3000 },
    );

    connection.close();
  });

  it('shares one real socket between two connections to the same url', async () => {
    const client = createClient({ baseUrl: server.url, heartbeat: false, closeDelay: 0 });
    const first = client.connect(hub);
    const second = client.connect(hub);
    await first.ready({ timeout: 2000 });

    expect(server.connections).toBe(1);

    first.close();
    second.close();
  });

  describe('two consumers on one shared socket', () => {
    function pair() {
      const client = createClient({
        baseUrl: server.url,
        heartbeat: false,
        closeDelay: 0,
      });
      return [client.connect(hub), client.connect(hub)] as const;
    }

    it('delivers each reply to the consumer that asked', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });
      const roomA = a.topic(roomTopic.with({ room_name: 'lobby' }));
      const roomB = b.topic(roomTopic.with({ room_name: 'lobby' }));
      await Promise.all([roomA.subscribe(), roomB.subscribe()]);

      // Same socket, same topic: only the ref tells the two replies apart.
      const [replyA, replyB] = await Promise.all([
        roomA.request({ action: 'post', payload: { body: 'from-a' } }),
        roomB.request({ action: 'post', payload: { body: 'from-b' } }),
      ]);

      expect(replyA).toMatchObject({ payload: { body: 'from-a' } });
      expect(replyB).toMatchObject({ payload: { body: 'from-b' } });
      a.close();
      b.close();
    });

    it('delivers each plain-channel reply to the consumer that asked', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });

      const [replyA, replyB] = await Promise.all([
        a.request({ action: 'post', payload: { body: 'from-a' } }),
        b.request({ action: 'post', payload: { body: 'from-b' } }),
      ]);

      expect(replyA).toMatchObject({ payload: { body: 'from-a' } });
      expect(replyB).toMatchObject({ payload: { body: 'from-b' } });
      a.close();
      b.close();
    });

    it('keeps one consumer’s plain reply out of the other’s handlers', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });

      const seenByB: string[] = [];
      b.onAny((message) => seenByB.push(message.action));
      await a.request({ action: 'ping', payload: null });

      expect(seenByB).toEqual([]);
      a.close();
      b.close();
    });

    it('keeps one consumer’s reply out of the other’s handlers', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });
      const roomA = a.topic(roomTopic.with({ room_name: 'lobby' }));
      const roomB = b.topic(roomTopic.with({ room_name: 'lobby' }));
      await Promise.all([roomA.subscribe(), roomB.subscribe()]);

      const seenByB: string[] = [];
      roomB.onAny((message) => seenByB.push(message.action));
      await roomA.request({ action: 'post', payload: { body: 'mine' } });

      expect(seenByB).toEqual([]);
      a.close();
      b.close();
    });

    it('keeps a topic subscribed while another consumer still holds it', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });

      const roomA = a.topic(roomTopic.with({ room_name: 'lobby' }));
      await roomA.subscribe({ timeout: 2000 });
      const roomB = b.topic(roomTopic.with({ room_name: 'lobby' }));
      await roomB.subscribe({ timeout: 2000 });

      roomA.release();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // The server tracks subscriptions per socket: an unsubscribe here would cut B off.
      expect(server.received.some((frame) => frame.action === 'unsubscribe')).toBe(false);

      roomB.release();
      await vi.waitFor(() =>
        expect(server.received.filter((f) => f.action === 'unsubscribe')).toHaveLength(1),
      );
      a.close();
      b.close();
    });

    describe.each(['unsubscribe', 'release', 'close'] as const)(
      'when one consumer leaves a shared topic by %s',
      (how) => {
        async function setup() {
          const [a, b] = pair();
          await a.ready({ timeout: 2000 });
          const roomA = a.topic(roomTopic.with({ room_name: 'lobby' }));
          await roomA.subscribe({ timeout: 2000 });
          const roomB = b.topic(roomTopic.with({ room_name: 'lobby' }));
          await roomB.subscribe({ timeout: 2000 });

          const gotA: string[] = [];
          const gotB: string[] = [];
          roomA.on('posted', (message) => gotA.push(message.payload.body));
          roomB.on('posted', (message) => gotB.push(message.payload.body));

          if (how === 'unsubscribe') await roomA.unsubscribe();
          if (how === 'release') roomA.release();
          if (how === 'close') a.close();
          await new Promise((resolve) => setTimeout(resolve, 30));

          return { a, b, roomA, roomB, gotA, gotB };
        }

        it('sends no unsubscribe and keeps the socket up', async () => {
          const { a, b } = await setup();
          expect(server.received.some((f) => f.action === 'unsubscribe')).toBe(false);
          expect(server.sockets.size).toBe(1);
          a.close();
          b.close();
        });

        it('keeps delivering to the consumer that stayed', async () => {
          const { a, b, gotB } = await setup();
          server.push({
            topic: 'room:lobby',
            action: 'posted',
            payload: { body: 'after' },
          });
          await vi.waitFor(() => expect(gotB).toEqual(['after']));
          a.close();
          b.close();
        });

        it('stops delivering to the consumer that left', async () => {
          const { a, b, gotA, gotB } = await setup();
          server.push({
            topic: 'room:lobby',
            action: 'posted',
            payload: { body: 'after' },
          });
          await vi.waitFor(() => expect(gotB).toHaveLength(1));
          // The server subscription is still alive for B, so frames keep arriving here.
          expect(gotA).toEqual([]);
          a.close();
          b.close();
        });

        it('unsubscribes on the wire once the other consumer leaves too', async () => {
          const { a, b, roomB } = await setup();
          roomB.release();
          await vi.waitFor(() =>
            expect(
              server.received.filter((f) => f.action === 'unsubscribe'),
            ).toHaveLength(1),
          );
          a.close();
          b.close();
        });
      },
    );

    it('resumes delivery when a consumer subscribes again after unsubscribing', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });
      const roomA = a.topic(roomTopic.with({ room_name: 'lobby' }));
      await roomA.subscribe({ timeout: 2000 });
      const roomB = b.topic(roomTopic.with({ room_name: 'lobby' }));
      await roomB.subscribe({ timeout: 2000 });
      const gotA: string[] = [];
      roomA.on('posted', (message) => gotA.push(message.payload.body));

      await roomA.unsubscribe();
      await roomA.subscribe({ timeout: 2000 });
      server.push({ topic: 'room:lobby', action: 'posted', payload: { body: 'back' } });

      await vi.waitFor(() => expect(gotA).toEqual(['back']));
      a.close();
      b.close();
    });

    it('terminates the real socket for both consumers, without reconnecting', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });
      expect(server.sockets.size).toBe(1);

      a.terminate(4001, 'logged out');

      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
      expect(b.status).toBe('closed');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.connections).toBe(1);
    });

    it('releases a closed consumer’s subscriptions while the socket lives on', async () => {
      const [a, b] = pair();
      await a.ready({ timeout: 2000 });

      const room = a.topic(roomTopic.with({ room_name: 'lobby' }));
      await room.subscribe({ timeout: 2000 });

      // `b` keeps the socket open, so nothing else would ever unsubscribe `a`'s topic.
      a.close();
      await vi.waitFor(() =>
        expect(server.received.some((frame) => frame.action === 'unsubscribe')).toBe(
          true,
        ),
      );
      expect(server.connections).toBe(1);
      b.close();
    });
  });

  it('runs no heartbeat on a channel that does not declare ping', async () => {
    // Client-wide options tune the heartbeat; they do not force it onto a consumer
    // that would answer every ping with an error.
    const client = createClient({
      baseUrl: server.url,
      closeDelay: 0,
      heartbeat: { interval: 30, timeout: 1000 },
    });
    const connection = client.connect(quiet);
    await connection.ready({ timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(server.received.some((frame) => frame.action === 'ping')).toBe(false);
    connection.close();
  });

  it('answers a heartbeat with the schema ping/pong', async () => {
    const connection = connect({ heartbeat: { interval: 30, timeout: 1000 } });
    await connection.ready({ timeout: 2000 });

    await vi.waitFor(
      () => expect(server.received.some((frame) => frame.action === 'ping')).toBe(true),
      { timeout: 2000 },
    );

    connection.close();
  });
});
