// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDefaultClient } from '../src/react/context';
import { useChannel } from '../src/react/useChannel';
import { useTopic } from '../src/react/useTopic';
import { useTopics } from '../src/react/useTopics';
import {
  accept,
  ackLast,
  chat,
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

afterEach(cleanup);

function Panel({ buffer }: { buffer?: 'latest' | 'all' } = {}) {
  const { status, lastMessage, messages, send } = useChannel(hub, { buffer });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="last">{lastMessage ? lastMessage.action : 'none'}</span>
      <span data-testid="count">{messages.length}</span>
      <button onClick={() => send({ action: 'ping', payload: null })}>ping</button>
    </div>
  );
}

describe('useChannel', () => {
  it('renders the connection status and follows it', async () => {
    render(<Panel />);
    expect(screen.getByTestId('status').textContent).toBe('connecting');

    await act(async () => accept());
    expect(screen.getByTestId('status').textContent).toBe('open');
  });

  it('re-renders with the latest message', async () => {
    render(<Panel />);
    await act(async () => accept());

    await act(async () => receive({ version: 1, action: 'pong', payload: null }));
    expect(screen.getByTestId('last').textContent).toBe('pong');
  });

  it('accumulates when buffer is all', async () => {
    render(<Panel buffer="all" />);
    await act(async () => accept());

    await act(async () => {
      receive({ version: 1, action: 'pong', payload: null });
      receive({ version: 1, action: 'posted', payload: { body: 'x' } });
    });

    expect(screen.getByTestId('count').textContent).toBe('2');
  });

  it('sends through the socket', async () => {
    render(<Panel />);
    await act(async () => accept());

    await act(async () => screen.getByRole('button').click());
    expect(FakeSocket.last.lastSent).toMatchObject({ action: 'ping' });
  });

  it('opens one socket for two components on a channel carrying topics', async () => {
    render(
      <>
        <Panel />
        <Panel />
      </>,
    );
    await act(async () => accept());
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('gives two components on a plain channel their own sockets by default', () => {
    function Plain() {
      useChannel(chat, { params: { room: 'lobby' } });
      return null;
    }
    render(
      <>
        <Plain />
        <Plain />
      </>,
    );
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('shares a plain channel between components that opt in', () => {
    function Plain() {
      useChannel(chat, { params: { room: 'lobby' }, share: true });
      return null;
    }
    render(
      <>
        <Plain />
        <Plain />
      </>,
    );
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('keeps the shared socket for the component that stays mounted', async () => {
    function Pair({ both }: { both: boolean }) {
      return (
        <>
          <Panel />
          {both && <Panel />}
        </>
      );
    }
    const view = render(<Pair both />);
    await act(async () => accept());

    await act(async () => {
      view.rerender(<Pair both={false} />);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.last.readyState).toBe(1);
  });

  it('terminates the shared socket for every component from one of them', async () => {
    function Owner() {
      const { status, terminate } = useChannel(hub);
      return (
        <>
          <span data-testid="owner">{status}</span>
          <button onClick={() => terminate(4001, 'logged out')}>log out</button>
        </>
      );
    }
    function Other() {
      const { status } = useChannel(hub);
      return <span data-testid="other">{status}</span>;
    }
    render(
      <>
        <Owner />
        <Other />
      </>,
    );
    await act(async () => accept());

    await act(async () => screen.getByRole('button').click());

    expect(screen.getByTestId('owner').textContent).toBe('closed');
    expect(screen.getByTestId('other').textContent).toBe('closed');
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('opens a private socket per component with share: false', async () => {
    function Private() {
      const { status } = useChannel(hub, { share: false });
      return <span>{status}</span>;
    }
    render(
      <>
        <Private />
        <Private />
      </>,
    );

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('closes the socket when the last consumer unmounts', async () => {
    const view = render(<Panel />);
    await act(async () => accept());

    await act(async () => {
      view.unmount();
      // `closeDelay` is 0 in the harness, so the grace period elapses immediately.
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(FakeSocket.last.readyState).toBe(3);
  });

  it('survives StrictMode double-mounting without churning sockets', async () => {
    render(
      <StrictMode>
        <Panel />
      </StrictMode>,
    );
    await act(async () => accept());

    // The grace period is what keeps the remount from building a second socket.
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects when a query param changes, but not on a re-render', async () => {
    function Tokened({ token }: { token: string }) {
      useChannel(hub, { queryParams: { token } });
      return null;
    }
    const view = render(<Tokened token="first" />);
    view.rerender(<Tokened token="first" />);
    await act(async () => view.rerender(<Tokened token="second" />));

    expect(FakeSocket.instances.map((socket) => socket.url)).toEqual([
      'ws://test.local/ws/topics?token=first',
      'ws://test.local/ws/topics?token=second',
    ]);
  });

  it('does not connect when disabled', () => {
    function Disabled() {
      const { status } = useChannel(hub, { enabled: false });
      return <span data-testid="status">{status}</span>;
    }
    render(<Disabled />);

    expect(FakeSocket.instances).toHaveLength(0);
    expect(screen.getByTestId('status').textContent).toBe('closed');
  });

  it('runs an on handler that closes over fresh state', async () => {
    const seen: number[] = [];
    function Counting({ tick }: { tick: number }) {
      useChannel(hub, {
        buffer: 'none',
        on: { pong: () => seen.push(tick) },
      });
      return null;
    }

    const view = render(<Counting tick={1} />);
    await act(async () => accept());

    view.rerender(<Counting tick={2} />);
    await act(async () => receive({ version: 1, action: 'pong', payload: null }));

    // The handler must see the latest render's value, not the one captured at connect.
    expect(seen).toEqual([2]);
  });
});

describe('useTopics', () => {
  function RoomPanel() {
    const { subscribed, lastMessage } = useTopics(hub, {
      topics: [roomTopic.with({ room_name: 'lobby' })],
    });
    return (
      <div>
        <span data-testid="subscribed">{subscribed.join(',')}</span>
        <span data-testid="last">{lastMessage ? lastMessage.topic : 'none'}</span>
      </div>
    );
  }

  it('subscribes and reports the confirmation', async () => {
    render(<RoomPanel />);
    await act(async () => accept());
    await act(async () => ackLast());

    await vi.waitFor(() =>
      expect(screen.getByTestId('subscribed').textContent).toBe('room:lobby'),
    );
  });

  it('delivers a topic message tagged with its topic', async () => {
    render(<RoomPanel />);
    await act(async () => accept());
    await act(async () => ackLast());

    await act(async () =>
      receive({
        version: 1,
        topic: 'room:lobby',
        action: 'posted',
        payload: { body: 'hi' },
      }),
    );

    expect(screen.getByTestId('last').textContent).toBe('room:lobby');
  });

  it('shows no subscriptions after the socket is terminated', async () => {
    function Terminating() {
      const { subscribed, status, terminate } = useTopics(hub, {
        topics: [roomTopic.with({ room_name: 'lobby' })],
      });
      return (
        <>
          <span data-testid="subscribed">{subscribed.join(',')}</span>
          <span data-testid="status">{status}</span>
          <button onClick={() => terminate()}>log out</button>
        </>
      );
    }
    render(<Terminating />);
    await act(async () => accept());
    await act(async () => ackLast());
    await vi.waitFor(() =>
      expect(screen.getByTestId('subscribed').textContent).toBe('room:lobby'),
    );

    await act(async () => screen.getByRole('button').click());

    expect(screen.getByTestId('status').textContent).toBe('closed');
    expect(screen.getByTestId('subscribed').textContent).toBe('');
  });

  it('gets the initial topic state under StrictMode', async () => {
    function Room() {
      const { lastMessage } = useTopics(hub, {
        topics: [roomTopic.with({ room_name: 'lobby' })],
      });
      const body = lastMessage ? lastMessage.payload.body : 'none';
      return <span data-testid="last">{body}</span>;
    }
    render(
      <StrictMode>
        <Room />
      </StrictMode>,
    );
    await act(async () => accept());

    // Both mounts subscribed; the socket is subscribed once, so chanx answers the first
    // with its ack and on_subscribe state (no ref: it is state, not a reply), and the
    // duplicate with an ack only.
    const [first, second] = FakeSocket.last.sent.filter(
      (frame) => frame.action === 'subscribe',
    );
    await act(async () => {
      receive({
        version: 1,
        topic: 'room:lobby',
        ref: first?.ref,
        action: 'subscribed',
        payload: null,
      });
      receive({
        version: 1,
        topic: 'room:lobby',
        action: 'posted',
        payload: { body: 'history' },
      });
      receive({
        version: 1,
        topic: 'room:lobby',
        ref: second?.ref,
        action: 'subscribed',
        payload: null,
      });
    });

    expect(screen.getByTestId('last').textContent).toBe('history');
  });

  it('unsubscribes on unmount', async () => {
    const view = render(<RoomPanel />);
    await act(async () => accept());
    await act(async () => ackLast());

    await act(async () => view.unmount());

    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'unsubscribe',
    });
  });
});

describe('useTopic', () => {
  function Room({ name }: { name: string }) {
    const { subscribed, lastMessage, send } = useTopic(
      hub,
      roomTopic.with({ room_name: name }),
    );
    return (
      <div>
        <span data-testid="subscribed">{String(subscribed)}</span>
        <span data-testid="last">{lastMessage ? lastMessage.payload.body : 'none'}</span>
        <button onClick={() => send({ action: 'post', payload: { body: 'hi' } })}>
          post
        </button>
      </div>
    );
  }

  it('joins the topic and renders its messages', async () => {
    render(<Room name="lobby" />);
    await act(async () => accept());
    await act(async () => ackLast());
    await act(async () =>
      receive({
        version: 1,
        topic: 'room:lobby',
        action: 'posted',
        payload: { body: 'hi' },
      }),
    );

    expect(screen.getByTestId('subscribed').textContent).toBe('true');
    expect(screen.getByTestId('last').textContent).toBe('hi');
  });

  it('sends on the topic', async () => {
    render(<Room name="lobby" />);
    await act(async () => accept());

    await act(async () => screen.getByRole('button').click());

    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'post',
    });
  });

  it('rejoins when the topic changes, but not on a re-render', async () => {
    const view = render(<Room name="lobby" />);
    await act(async () => accept());
    view.rerender(<Room name="lobby" />);
    await act(async () => view.rerender(<Room name="kitchen" />));

    const subscribes = FakeSocket.last.sent
      .filter((frame) => frame.action === 'subscribe')
      .map((frame) => frame.topic);
    expect(subscribes).toEqual(['room:lobby', 'room:kitchen']);
  });
});
