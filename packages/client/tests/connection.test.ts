import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientOptions } from '../src/core/client';
import { createClient } from '../src/core/client';
import { ChanxRequestError } from '../src/core/connection';
import { defineChannel, defineTopic } from '../src/core/descriptor';
import { ENVELOPE_VERSION } from '../src/core/protocol';
import { resetSockets, terminateAllSockets } from '../src/core/socket';
import { FakeSocket, fakeFactory } from './fake-socket';

type Ping = { action: 'ping'; payload: null };
type Post = { action: 'post'; payload: { body: string } };
type Pong = { action: 'pong'; payload: null };
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

const chat = defineChannel<Ping, Pong>()({
  name: 'chat',
  address: '/ws/chat/{room}/',
});

const makeSharingClient = () => makeClient({ share: true });

function makeClient(overrides: Partial<ClientOptions> = {}) {
  return createClient({
    baseUrl: 'ws://test.local',
    socketFactory: fakeFactory,
    closeDelay: 0,
    heartbeat: false,
    ...overrides,
  });
}

beforeEach(() => {
  resetSockets();
  FakeSocket.reset();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('url resolution', () => {
  it('encodes param values so each stays one path segment', () => {
    expect(makeClient().urlFor(chat, { params: { room: 'a b/../x?y' } })).toBe(
      'ws://test.local/ws/chat/a%20b%2F..%2Fx%3Fy/',
    );
  });

  it('keeps topic names raw, as the server compares them verbatim', () => {
    const connection = makeClient().connect(hub);
    expect(connection.topic(roomTopic.with({ room_name: 'a/b c' })).topic).toBe(
      'room:a/b c',
    );
  });

  it('merges per-connection query params over the client-wide ones', () => {
    const client = makeClient({ queryParams: { token: 't', lang: 'en' } });
    expect(
      client.urlFor(chat, { params: { room: 'r' }, queryParams: { lang: 'vi' } }),
    ).toBe('ws://test.local/ws/chat/r/?token=t&lang=vi');
  });

  it('fills address params', () => {
    const client = makeClient();
    expect(client.urlFor(chat, { params: { room: 'lobby' } })).toBe(
      'ws://test.local/ws/chat/lobby/',
    );
  });

  it('refuses to guess a missing param', () => {
    const client = makeClient();
    expect(() => client.urlFor(chat, { params: {} as never })).toThrow(
      /Missing parameter/,
    );
  });
});

describe('sending', () => {
  it('stamps the envelope version', () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();
    connection.send({ action: 'ping', payload: null });
    expect(FakeSocket.last.lastSent).toEqual({
      version: ENVELOPE_VERSION,
      action: 'ping',
      payload: null,
    });
  });

  it('queues frames sent before the socket opens', () => {
    const connection = makeClient().connect(hub);
    connection.send({ action: 'ping', payload: null });
    expect(FakeSocket.last.sent).toHaveLength(0);

    FakeSocket.last.accept();
    expect(FakeSocket.last.sent).toHaveLength(1);
  });
});

describe('request correlation', () => {
  it('resolves the frame carrying the same ref', async () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const pending = connection.request({ action: 'ping', payload: null });
    const ref = FakeSocket.last.lastSent.ref as string;
    FakeSocket.last.receive({ version: 1, ref, action: 'pong', payload: null });

    await expect(pending).resolves.toEqual({ action: 'pong', payload: null });
  });

  it('rejects when the server answers with an error frame', async () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const pending = connection.request({ action: 'ping', payload: null });
    const ref = FakeSocket.last.lastSent.ref as string;
    FakeSocket.last.receive({
      version: 1,
      ref,
      action: 'error',
      payload: { detail: 'nope' },
    });

    await expect(pending).rejects.toBeInstanceOf(ChanxRequestError);
  });

  it('times out rather than hanging', async () => {
    vi.useFakeTimers();
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const pending = connection.request(
      { action: 'ping', payload: null },
      { timeout: 50 },
    );
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });
});

describe('framework frames', () => {
  it('absorbs completion frames instead of passing them to handlers', () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const onAny = vi.fn();
    const onComplete = vi.fn();
    connection.onAny(onAny);
    connection.onComplete(onComplete);

    FakeSocket.last.receive({ version: 1, action: 'complete', payload: null });

    expect(onAny).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('routes errors to onError', () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const onError = vi.fn();
    connection.onError(onError);
    FakeSocket.last.receive({ version: 1, action: 'error', payload: { detail: 'bad' } });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'error', payload: { detail: 'bad' } }),
    );
  });
});

describe('unhandled messages', () => {
  it('reports a message no handler claimed', () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const onUnhandled = vi.fn();
    connection.onUnhandled(onUnhandled);
    FakeSocket.last.receive({ version: 1, action: 'pong', payload: null });

    expect(onUnhandled).toHaveBeenCalledOnce();
  });

  it('stays quiet once a handler exists for the action', () => {
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    const onUnhandled = vi.fn();
    const onPong = vi.fn();
    connection.onUnhandled(onUnhandled);
    connection.on('pong', onPong);
    FakeSocket.last.receive({ version: 1, action: 'pong', payload: null });

    expect(onPong).toHaveBeenCalledOnce();
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe('socket sharing', () => {
  // `chat` is a plain channel, so these opt in the way an application would.
  const makeClient = () => makeSharingClient();

  it('reuses one socket for the same resolved url', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' } });
    client.connect(chat, { params: { room: 'lobby' } });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('opens separate sockets for different params', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' } });
    client.connect(chat, { params: { room: 'other' } });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('keeps the socket while another consumer holds it', async () => {
    const client = makeClient();
    const first = client.connect(chat, { params: { room: 'lobby' } });
    const second = client.connect(chat, { params: { room: 'lobby' } });
    FakeSocket.last.accept();

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeSocket.last.readyState).not.toBe(3);

    second.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeSocket.last.readyState).toBe(3);
  });

  it('opens a private socket for share: false, even on the same url', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' } });
    client.connect(chat, { params: { room: 'lobby' }, share: false });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('never lets a shared consumer join a private socket', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' }, share: false });
    client.connect(chat, { params: { room: 'lobby' } });
    client.connect(chat, { params: { room: 'lobby' } });
    // One private, plus one shared that the second and third consumers joined.
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('gives each share: false consumer its own socket', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' }, share: false });
    client.connect(chat, { params: { room: 'lobby' }, share: false });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('leaves the shared socket up when a private one closes', async () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' } });
    const shared = FakeSocket.last;
    const isolated = client.connect(chat, { params: { room: 'lobby' }, share: false });
    const priv = FakeSocket.last;
    shared.accept();
    priv.accept();

    isolated.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(priv.readyState).toBe(3);
    expect(shared.readyState).toBe(1);
  });

  it('keeps the first consumer’s socket options for later joiners', async () => {
    // Reconnect settings belong to the socket, so a joiner cannot change them.
    const client = makeClient();
    const onReconnectStop = vi.fn();
    const first = client.connect(chat, {
      params: { room: 'lobby' },
      reconnectAttempts: 0,
      onReconnectStop,
    });
    client.connect(chat, { params: { room: 'lobby' }, reconnectAttempts: 50 });
    FakeSocket.last.accept();

    FakeSocket.last.close(1006, 'dropped');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onReconnectStop).toHaveBeenCalledOnce();
    expect(first.status).toBe('closed');
  });
});

describe('terminate', () => {
  function sharedPair() {
    const client = createClient({
      baseUrl: 'ws://test.local',
      socketFactory: fakeFactory,
      closeDelay: 0,
      heartbeat: false,
      reconnectInterval: 5,
      share: true,
    });
    const a = client.connect(chat, { params: { room: 'lobby' } });
    const b = client.connect(chat, { params: { room: 'lobby' } });
    FakeSocket.last.accept();
    return { client, a, b };
  }

  it('closes the shared socket for every consumer, not just the caller', () => {
    const { a, b } = sharedPair();
    a.terminate();

    expect(FakeSocket.last.readyState).toBe(3);
    expect(a.status).toBe('closed');
    expect(b.status).toBe('closed');
  });

  it('passes the close code and reason through', () => {
    const { a } = sharedPair();
    const socket = FakeSocket.last;
    const onclose = vi.fn();
    const original = socket.onclose;
    socket.onclose = (event) => {
      onclose(event);
      original?.(event);
    };

    a.terminate(4001, 'logged out');
    expect(onclose).toHaveBeenCalledWith({ code: 4001, reason: 'logged out' });
  });

  it('rejects pending requests on every consumer', async () => {
    const { a, b } = sharedPair();
    const pendingA = a.request({ action: 'ping', payload: null });
    const pendingB = b.request({ action: 'ping', payload: null });

    a.terminate();

    await expect(pendingA).rejects.toThrow(/terminated/);
    await expect(pendingB).rejects.toThrow(/terminated/);
  });

  it('ends open streams on every consumer', async () => {
    const { a, b } = sharedPair();
    const stream = b.stream();
    const drained = (async () => {
      for await (const message of stream) void message;
      return 'ended';
    })();

    a.terminate();
    await expect(drained).resolves.toBe('ended');
  });

  it('does not reconnect afterwards', async () => {
    const { a } = sharedPair();
    a.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('lets the next connect open a fresh socket', () => {
    const { client, a } = sharedPair();
    a.terminate();

    const fresh = client.connect(chat, { params: { room: 'lobby' } });
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.last.accept();
    expect(fresh.status).toBe('open');
  });

  it('does not let a stale consumer’s close touch the fresh socket', async () => {
    const { client, a, b } = sharedPair();
    a.terminate();
    const fresh = client.connect(chat, { params: { room: 'lobby' } });
    const freshSocket = FakeSocket.last;
    freshSocket.accept();

    // The old consumers still get cleaned up by their owners later, as a hook would.
    a.close();
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(freshSocket.readyState).toBe(1);
    // A third connect must still join the fresh socket, so its registry entry survived.
    client.connect(chat, { params: { room: 'lobby' } });
    expect(FakeSocket.instances).toHaveLength(2);
    fresh.close();
  });

  it('drops sends made after termination instead of queueing them', () => {
    const { a } = sharedPair();
    a.terminate();
    expect(() => a.send({ action: 'ping', payload: null })).not.toThrow();
    expect(FakeSocket.last.sent).toHaveLength(0);
  });
});

describe('closeAll', () => {
  it('terminates every socket the client opened', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'one' } });
    client.connect(chat, { params: { room: 'two' } });
    client.connect(chat, { params: { room: 'two' }, share: false });

    client.closeAll();

    expect(FakeSocket.instances).toHaveLength(3);
    expect(FakeSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
  });

  it('leaves sockets opened by another client alone', () => {
    const mine = makeClient();
    const theirs = makeClient();
    mine.connect(chat, { params: { room: 'mine' } });
    theirs.connect(chat, { params: { room: 'theirs' } });
    const [mineSocket, theirSocket] = FakeSocket.instances;

    mine.closeAll();

    expect(mineSocket?.readyState).toBe(3);
    expect(theirSocket?.readyState).not.toBe(3);
  });

  it('forgets sockets that were already closed', async () => {
    const client = makeClient();
    const connection = client.connect(chat, { params: { room: 'one' } });
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(() => client.closeAll()).not.toThrow();
  });
});

describe('terminateAllSockets', () => {
  it('closes every socket across every client', () => {
    makeClient().connect(chat, { params: { room: 'one' } });
    makeClient().connect(chat, { params: { room: 'two' } });

    terminateAllSockets();

    expect(FakeSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
  });
});

describe('heartbeat resolution', () => {
  const pinging = defineChannel<Ping, Pong>()({
    name: 'pinging',
    address: '/ws/pinging',
    heartbeat: true,
  });
  const silent = defineChannel<Ping, Pong>()({ name: 'silent', address: '/ws/silent' });

  async function pingsSent(
    descriptor: typeof pinging | typeof silent,
    clientHeartbeat: unknown,
    connectHeartbeat?: unknown,
  ): Promise<number> {
    const client = createClient({
      baseUrl: 'ws://test.local',
      socketFactory: fakeFactory,
      closeDelay: 0,
      ...(clientHeartbeat === undefined ? {} : { heartbeat: clientHeartbeat as never }),
    });
    const connection = client.connect(
      descriptor,
      connectHeartbeat === undefined ? {} : { heartbeat: connectHeartbeat as never },
    );
    FakeSocket.last.accept();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const count = FakeSocket.last.sent.filter((frame) => frame.action === 'ping').length;
    connection.close();
    return count;
  }

  const fast = { interval: 10, timeout: 1000 };

  it('runs on a channel that declares ping, tuned by client options', async () => {
    expect(await pingsSent(pinging, fast)).toBeGreaterThan(0);
  });

  it('stays off on a channel that does not declare ping, despite client options', async () => {
    expect(await pingsSent(silent, fast)).toBe(0);
  });

  it('lets a per-connection setting force it on', async () => {
    expect(await pingsSent(silent, undefined, fast)).toBeGreaterThan(0);
  });

  it('lets a per-connection false turn it off', async () => {
    expect(await pingsSent(pinging, fast, false)).toBe(0);
  });

  it('lets a client-wide false turn it off everywhere', async () => {
    expect(await pingsSent(pinging, false)).toBe(0);
  });
});

describe('default sharing', () => {
  it('gives each consumer of a plain channel its own socket', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' } });
    client.connect(chat, { params: { room: 'lobby' } });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('shares one socket between consumers of a channel carrying topics', () => {
    const client = makeClient();
    client.connect(hub);
    client.connect(hub);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('keeps a plain channel reply away from other consumers by default', () => {
    // The reason for the default: a shared plain socket is one inbox.
    const client = makeClient();
    const a = client.connect(chat, { params: { room: 'lobby' } });
    const b = client.connect(chat, { params: { room: 'lobby' } });
    const [socketA] = FakeSocket.instances;
    socketA?.accept();
    FakeSocket.instances[1]?.accept();

    const seenByB = vi.fn();
    b.onAny(seenByB);
    socketA?.receive({ action: 'pong', payload: null });

    expect(seenByB).not.toHaveBeenCalled();
    a.close();
    b.close();
  });

  it('lets a plain channel opt in per connection', () => {
    const client = makeClient();
    client.connect(chat, { params: { room: 'lobby' }, share: true });
    client.connect(chat, { params: { room: 'lobby' }, share: true });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('lets a topic channel opt out per connection', () => {
    const client = makeClient();
    client.connect(hub);
    client.connect(hub, { share: false });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('honours a client-wide setting over the default', () => {
    const sharing = makeClient({ share: true });
    sharing.connect(chat, { params: { room: 'a' } });
    sharing.connect(chat, { params: { room: 'a' } });
    expect(FakeSocket.instances).toHaveLength(1);

    const isolated = makeClient({ share: false });
    isolated.connect(hub);
    isolated.connect(hub);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('lets a per-connection setting beat the client-wide one', () => {
    const client = makeClient({ share: false });
    client.connect(hub, { share: true });
    client.connect(hub, { share: true });
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('rejoining a socket', () => {
  it('opens one replacement when a consumer joins during a pending reconnect', async () => {
    const client = makeClient({ reconnectInterval: 10 });
    client.connect(hub);
    FakeSocket.last.accept();
    FakeSocket.last.close(1006);

    client.connect(hub);
    await wait(30);

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('ignores events from a WebSocket that has been replaced', async () => {
    const client = makeClient({ reconnectInterval: 1 });
    const connection = client.connect(hub);
    const stale = FakeSocket.last;
    stale.accept();
    stale.close(1006);
    await wait(10);
    FakeSocket.last.accept();

    const seen = vi.fn();
    connection.on('pong', seen);
    stale.receive({ version: 1, action: 'pong', payload: null });

    expect(seen).not.toHaveBeenCalled();
    expect(connection.status).toBe('open');
  });

  it('retries afresh when a consumer joins after reconnecting gave up', async () => {
    const client = makeClient({ reconnectInterval: 1, reconnectAttempts: 1 });
    const first = client.connect(hub);
    FakeSocket.last.accept();
    FakeSocket.last.close(1006);
    await wait(10);
    FakeSocket.last.close(1006);
    await wait(10);
    expect(first.status).toBe('closed');

    client.connect(hub);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.last.close(1006);
    await wait(10);

    // A fresh attempt budget: it retries rather than giving up at once.
    expect(FakeSocket.instances).toHaveLength(4);
  });
});

describe('socket identity', () => {
  it('never shares a socket opened with different subprotocols', () => {
    const client = makeClient();
    client.connect(hub, { protocols: ['token.a'] });
    client.connect(hub, { protocols: ['token.b'] });
    client.connect(hub, { protocols: ['token.a'] });

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('never shares a socket built by a different factory', () => {
    const otherFactory: typeof fakeFactory = (url) => fakeFactory(url);
    makeClient().connect(hub);
    makeClient({ socketFactory: otherFactory }).connect(hub);

    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('heartbeat liveness', () => {
  const pinging = defineChannel<Ping, Pong>()({
    name: 'pinging',
    address: '/ws/pinging',
    heartbeat: true,
  });

  it('closes a silent socket even when the timeout is longer than the interval', async () => {
    makeClient({ heartbeat: { interval: 5, timeout: 20 } }).connect(pinging);
    const socket = FakeSocket.last;
    socket.accept();

    await wait(60);

    expect(socket.readyState).toBe(3);
  });

  it('keeps a socket that answers', async () => {
    makeClient({ heartbeat: { interval: 5, timeout: 20 } }).connect(pinging);
    const socket = FakeSocket.last;
    socket.accept();
    const answering = setInterval(
      () => socket.receive({ version: 1, action: 'pong', payload: null }),
      3,
    );

    await wait(60);
    clearInterval(answering);

    expect(socket.readyState).toBe(1);
  });
});

describe('listener errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a throwing handler and still delivers to other consumers', () => {
    const reported = vi.fn();
    vi.stubGlobal('reportError', reported);
    const client = makeClient();
    const failing = client.connect(hub);
    const other = client.connect(hub);
    FakeSocket.last.accept();

    const boom = new Error('boom');
    failing.on('pong', () => {
      throw boom;
    });
    const seen = vi.fn();
    other.on('pong', seen);
    FakeSocket.last.receive({ version: 1, action: 'pong', payload: null });

    expect(seen).toHaveBeenCalledOnce();
    expect(reported).toHaveBeenCalledWith(boom);
  });

  it('still runs the other handlers of the same connection', () => {
    vi.stubGlobal('reportError', vi.fn());
    const connection = makeClient().connect(hub);
    FakeSocket.last.accept();

    connection.on('pong', () => {
      throw new Error('boom');
    });
    const seen = vi.fn();
    connection.onAny(seen);
    FakeSocket.last.receive({ version: 1, action: 'pong', payload: null });

    expect(seen).toHaveBeenCalledOnce();
  });
});

describe('inbound validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  const validated = defineChannel<Ping, Pong>()({
    name: 'validated',
    address: '/ws/validated',
    validators: {
      // Like zod's `parse`: rejects a wrong shape, returns a copy without unknown keys.
      toClient: (value) => {
        if ((value as Pong).action !== 'pong') throw new Error('not a pong');
        return { action: 'pong', payload: null };
      },
    },
  });

  it('delivers the message as received, not the validator’s copy', () => {
    const connection = makeClient({ validate: { inbound: true } }).connect(validated);
    FakeSocket.last.accept();
    const seen = vi.fn();
    connection.onAny(seen);

    FakeSocket.last.receive({ version: 1, action: 'pong', payload: null, extra: 1 });

    expect(seen).toHaveBeenCalledWith(
      { action: 'pong', payload: null, extra: 1 },
      { version: 1 },
    );
  });

  it('reports and drops a message that fails validation', () => {
    const reported = vi.fn();
    vi.stubGlobal('reportError', reported);
    const connection = makeClient({ validate: { inbound: true } }).connect(validated);
    FakeSocket.last.accept();
    const seen = vi.fn();
    connection.onAny(seen);

    FakeSocket.last.receive({ version: 1, action: 'bogus', payload: null });

    expect(seen).not.toHaveBeenCalled();
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'not a pong' }),
    );
  });
});

describe('streams', () => {
  it('stops tracking a stream once it is closed', () => {
    const connection = makeClient().connect(hub);
    const streams = (connection as unknown as { streams: Set<unknown> }).streams;

    connection.stream().close();
    connection.stream({ signal: AbortSignal.abort() });

    expect(streams.size).toBe(0);
  });
});
