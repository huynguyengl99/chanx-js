// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';

import {
  chanxPlugin,
  setDefaultClient,
  useChannel,
  useTopic,
  useTopics,
} from '../src/vue';
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

const Panel = defineComponent({
  props: { buffer: { type: String, default: 'latest' } },
  setup(props) {
    const { status, lastMessage, messages, send } = useChannel(hub, {
      buffer: props.buffer as 'latest' | 'all',
    });
    return () =>
      h('div', [
        h('span', { class: 'status' }, status.value),
        h(
          'span',
          { class: 'last' },
          lastMessage.value ? lastMessage.value.action : 'none',
        ),
        h('span', { class: 'count' }, String(messages.value.length)),
        h('button', { onClick: () => send({ action: 'ping', payload: null }) }, 'ping'),
      ]);
  },
});

describe('useChannel', () => {
  it('follows the connection status', async () => {
    const view = mount(Panel);
    expect(view.find('.status').text()).toBe('connecting');

    accept();
    await nextTick();
    expect(view.find('.status').text()).toBe('open');
  });

  it('re-renders with the latest message', async () => {
    const view = mount(Panel);
    accept();
    receive({ version: 1, action: 'pong', payload: null });
    await nextTick();

    expect(view.find('.last').text()).toBe('pong');
  });

  it('accumulates when buffer is all', async () => {
    const view = mount(Panel, { props: { buffer: 'all' } });
    accept();
    receive({ version: 1, action: 'pong', payload: null });
    receive({ version: 1, action: 'posted', payload: { body: 'x' } });
    await nextTick();

    expect(view.find('.count').text()).toBe('2');
  });

  it('sends through the socket', async () => {
    const view = mount(Panel);
    accept();
    await view.find('button').trigger('click');

    expect(FakeSocket.last.lastSent).toMatchObject({ action: 'ping' });
  });

  it('closes the connection when the component unmounts', async () => {
    const view = mount(Panel);
    accept();
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(FakeSocket.last.readyState).toBe(3);
  });

  it('reconnects when reactive params change', async () => {
    const room = ref({ room: 'lobby' });
    const Reactive = defineComponent({
      setup() {
        // `chat` addresses /ws/chat/{room}/, so the param is part of the URL.
        const { status } = useChannel(chat, { params: room });
        return () => h('span', status.value);
      },
    });

    mount(Reactive);
    expect(FakeSocket.instances).toHaveLength(1);

    // A param change must resolve a new URL and rebuild the connection.
    room.value = { room: 'other' };
    await nextTick();
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it('reconnects when a reactive query param changes', async () => {
    const token = ref({ token: 'first' });
    const Reactive = defineComponent({
      setup() {
        const { status } = useChannel(hub, { queryParams: token });
        return () => h('span', status.value);
      },
    });

    mount(Reactive);
    token.value = { token: 'second' };
    await nextTick();

    expect(FakeSocket.instances.map((socket) => socket.url)).toEqual([
      'ws://test.local/ws/topics?token=first',
      'ws://test.local/ws/topics?token=second',
    ]);
  });

  it('opens nothing while rendering on the server', async () => {
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('vue/server-renderer');

    const html = await renderToString(createSSRApp(Panel));

    expect(FakeSocket.instances).toHaveLength(0);
    expect(html).toContain('connecting');
  });

  it('takes a client from the plugin over the default', () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'connect');

    mount(Panel, { global: { plugins: [[chanxPlugin, client]] } });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not connect when disabled', () => {
    const Disabled = defineComponent({
      setup() {
        const { status } = useChannel(hub, { enabled: false });
        return () => h('span', status.value);
      },
    });
    const view = mount(Disabled);

    expect(FakeSocket.instances).toHaveLength(0);
    expect(view.text()).toBe('closed');
  });
});

describe('useTopics', () => {
  const RoomPanel = defineComponent({
    setup() {
      const { subscribed, lastMessage } = useTopics(hub, {
        topics: [roomTopic.with({ room_name: 'lobby' })],
      });
      return () =>
        h('div', [
          h('span', { class: 'subscribed' }, subscribed.value.join(',')),
          h(
            'span',
            { class: 'last' },
            lastMessage.value ? lastMessage.value.topic : 'none',
          ),
        ]);
    },
  });

  it('rejoins when a reactive topic list changes', async () => {
    const room = ref('lobby');
    const topics = computed(() => [roomTopic.with({ room_name: room.value })] as const);
    const Rooms = defineComponent({
      setup() {
        const { subscribed } = useTopics(hub, { topics });
        return () => h('span', subscribed.value.join(','));
      },
    });

    mount(Rooms);
    accept();
    room.value = 'kitchen';
    await nextTick();
    accept();

    const subscribes = FakeSocket.instances.flatMap((socket) =>
      socket.sent
        .filter((frame) => frame.action === 'subscribe')
        .map((frame) => frame.topic),
    );
    expect(subscribes).toEqual(['room:lobby', 'room:kitchen']);
  });

  it('subscribes and reports the confirmation', async () => {
    const view = mount(RoomPanel);
    accept();
    ackLast();

    await vi.waitFor(async () => {
      await nextTick();
      expect(view.find('.subscribed').text()).toBe('room:lobby');
    });
  });

  it('delivers a topic message tagged with its topic', async () => {
    const view = mount(RoomPanel);
    accept();
    ackLast();
    receive({
      version: 1,
      topic: 'room:lobby',
      action: 'posted',
      payload: { body: 'hi' },
    });
    await nextTick();

    expect(view.find('.last').text()).toBe('room:lobby');
  });

  it('unsubscribes on unmount', async () => {
    const view = mount(RoomPanel);
    accept();
    ackLast();
    await vi.waitFor(() => expect(FakeSocket.last.sent.length).toBeGreaterThan(0));

    view.unmount();
    expect(FakeSocket.last.lastSent).toMatchObject({
      topic: 'room:lobby',
      action: 'unsubscribe',
    });
  });
});

describe('useTopic', () => {
  it('joins the topic and rejoins when a computed topic changes', async () => {
    const room = ref('lobby');
    const Room = defineComponent({
      setup() {
        const { subscribed, lastMessage } = useTopic(
          hub,
          computed(() => roomTopic.with({ room_name: room.value })),
        );
        return () =>
          h(
            'span',
            `${String(subscribed.value)}|${lastMessage.value?.payload.body ?? 'none'}`,
          );
      },
    });

    const view = mount(Room);
    accept();
    ackLast();
    receive({
      version: 1,
      topic: 'room:lobby',
      action: 'posted',
      payload: { body: 'hi' },
    });
    await vi.waitFor(async () => {
      await nextTick();
      expect(view.text()).toBe('true|hi');
    });

    room.value = 'kitchen';
    await nextTick();

    const subscribes = FakeSocket.last.sent
      .filter((frame) => frame.action === 'subscribe')
      .map((frame) => frame.topic);
    expect(subscribes).toEqual(['room:lobby', 'room:kitchen']);
  });
});
