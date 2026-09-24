import type { AsyncAPIDocument, ChannelObject, TopicExtension } from './schema';
import { messageSchemaName, refName } from './schema';

export interface ChannelInfo {
  /** Key in `channels`. */
  key: string;
  /** chanx's own name for the channel, used as the descriptor's `name`. */
  name: string;
  address: string;
  description?: string;
  toServer: string[];
  toClient: string[];
  topic?: TopicExtension;
  /** Sends `ping` and receives `pong`, so the runtime may heartbeat it. */
  heartbeat: boolean;
}

export interface ConnectionInfo extends ChannelInfo {
  topics: ChannelInfo[];
}

function directions(
  document: AsyncAPIDocument,
): Map<string, { toServer: Set<string>; toClient: Set<string> }> {
  const result = new Map<string, { toServer: Set<string>; toClient: Set<string> }>();
  for (const key of Object.keys(document.channels ?? {})) {
    result.set(key, { toServer: new Set(), toClient: new Set() });
  }

  for (const operation of Object.values(document.operations ?? {})) {
    const channelKey = refName(operation.channel?.$ref ?? '');
    const bucket = result.get(channelKey);
    if (!bucket) continue;

    // AsyncAPI names operations from the server's point of view: the server
    // `receive`s what the client sends.
    const target = operation.action === 'send' ? bucket.toClient : bucket.toServer;
    for (const message of operation.messages ?? []) {
      const name = messageSchemaName(document, message.$ref);
      if (name) target.add(name);
    }
    for (const message of operation.reply?.messages ?? []) {
      const name = messageSchemaName(document, message.$ref);
      if (name) bucket.toClient.add(name);
    }
  }

  return result;
}

/** The `action` constant a message schema pins, if it pins one. */
function actionOf(document: AsyncAPIDocument, schemaName: string): unknown {
  return document.components?.schemas?.[schemaName]?.properties?.action?.const;
}

function describe(
  document: AsyncAPIDocument,
  key: string,
  channel: ChannelObject,
  buckets: Map<string, { toServer: Set<string>; toClient: Set<string> }>,
): ChannelInfo {
  const bucket = buckets.get(key);
  const toServer = [...(bucket?.toServer ?? [])].sort();
  const toClient = [...(bucket?.toClient ?? [])].sort();
  const info: ChannelInfo = {
    key,
    name: channel.title ?? key,
    address: channel.address ?? '',
    toServer,
    toClient,
    // chanx has no built-in ping handler: only a channel that declares both halves
    // answers a heartbeat with anything but an error.
    heartbeat:
      toServer.some((name) => actionOf(document, name) === 'ping') &&
      toClient.some((name) => actionOf(document, name) === 'pong'),
  };
  if (channel.description) info.description = channel.description;
  if (channel['x-topic']) info.topic = channel['x-topic'];
  return info;
}

/**
 * Split channels into connections and the topics riding on them.
 *
 * A topic channel shares its connection's address, which is what groups the two;
 * chanx's own Python generator uses the same rule. A topic channel with no plain
 * channel at its address owns its connection, so it is emitted as both.
 */
export function analyze(document: AsyncAPIDocument): ConnectionInfo[] {
  const buckets = directions(document);
  const channels = Object.entries(document.channels ?? {}).map(([key, channel]) =>
    describe(document, key, channel, buckets),
  );

  const connections = channels.filter((channel) => !channel.topic);
  const topics = channels.filter((channel) => channel.topic);
  const byAddress = new Map<string, ConnectionInfo>();

  const result: ConnectionInfo[] = connections.map((channel) => {
    const connection: ConnectionInfo = { ...channel, topics: [] };
    byAddress.set(channel.address, connection);
    return connection;
  });

  for (const topic of topics) {
    const parent = byAddress.get(topic.address);
    if (parent) {
      parent.topics.push(topic);
      continue;
    }
    // No plain channel at this address: the topic channel is its own connection.
    const standalone: ConnectionInfo = { ...topic, topics: [topic] };
    byAddress.set(topic.address, standalone);
    result.push(standalone);
  }

  return result.sort((a, b) => a.key.localeCompare(b.key));
}
