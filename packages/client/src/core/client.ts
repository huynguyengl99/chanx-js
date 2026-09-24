import type { ValidateConfig } from './connection';
import { ChannelConnection } from './connection';
import type {
  AddressOf,
  ChannelDescriptor,
  ParamsOf,
  ToClientOf,
  ToServerOf,
} from './descriptor';
import { formatPattern } from './protocol';
import type { SharedSocket, SocketOptions } from './socket';
import { acquireSocket } from './socket';

export interface ClientOptions extends SocketOptions {
  /** Server origin, e.g. `wss://api.example.com`. Relative addresses resolve against it. */
  baseUrl?: string;
  validate?: ValidateConfig;
}

export interface ConnectOptions<Address extends string> extends SocketOptions {
  params?: ParamsOf<Address>;
  validate?: ValidateConfig;
}

/** The convention bundlers replace at build time; false when nothing defines it. */
function isDev(): boolean {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

function resolveValidate(
  clientConfig: ValidateConfig | undefined,
  callConfig: ValidateConfig | undefined,
): { inbound: boolean; outbound: boolean } {
  const merged = { ...clientConfig, ...callConfig };
  return {
    outbound: merged.outbound ?? true,
    inbound: merged.inbound ?? isDev(),
  };
}

function buildUrl(
  baseUrl: string | undefined,
  address: string,
  params: Record<string, string | number>,
  queryParams: Record<string, string | number> | undefined,
): string {
  const path = formatPattern(address, params, encodeURIComponent);
  let url: string;

  if (/^wss?:\/\//.test(path)) {
    url = path;
  } else if (baseUrl) {
    const base = baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    url = `${base}/${path.replace(/^\/+/, '')}`;
  } else if (typeof location !== 'undefined') {
    url = new URL(path, location.href).toString().replace(/^http/, 'ws');
  } else {
    throw new Error(
      'No `baseUrl` and no `location` to resolve a relative address against',
    );
  }

  if (queryParams && Object.keys(queryParams).length > 0) {
    const query = new URLSearchParams(
      Object.entries(queryParams).map(([key, value]) => [key, String(value)]),
    );
    url += (url.includes('?') ? '&' : '?') + query.toString();
  }
  return url;
}

/**
 * Decide whether a connection runs a heartbeat.
 *
 * A per-connection setting is explicit and wins. A client-wide `false` turns it off
 * everywhere, and client-wide options only tune it. Otherwise it runs exactly on channels
 * that declare ping/pong, since a chanx consumer without a ping handler answers each ping
 * with an `error` frame.
 */
function resolveHeartbeat(
  clientOptions: ClientOptions,
  connectOptions: SocketOptions,
  descriptor: ChannelDescriptor<any, any, any, any>,
): SocketOptions['heartbeat'] {
  if (connectOptions.heartbeat !== undefined) return connectOptions.heartbeat;
  if (clientOptions.heartbeat === false) return false;
  if (!descriptor.heartbeat) return false;
  return clientOptions.heartbeat ?? {};
}

/**
 * Decide whether a connection shares its socket.
 *
 * An explicit setting wins, per connection first, then client-wide. Otherwise only a
 * channel carrying topics shares: topics route each frame to the consumer that asked for
 * it, while a plain channel's shared socket is one inbox, so a reply to one consumer's
 * `send()` would reach every other consumer too.
 */
function resolveShare(
  clientOptions: ClientOptions,
  connectOptions: SocketOptions,
  descriptor: ChannelDescriptor<any, any, any, any>,
): boolean {
  if (connectOptions.share !== undefined) return connectOptions.share;
  if (clientOptions.share !== undefined) return clientOptions.share;
  return Object.keys(descriptor.topics).length > 0;
}

export interface ChanxClient {
  readonly options: ClientOptions;
  connect<D extends ChannelDescriptor<any, any, any, any>>(
    descriptor: D,
    options?: ConnectOptions<AddressOf<D>>,
  ): ChannelConnection<ToServerOf<D>, ToClientOf<D>>;
  /**
   * Terminate every socket this client opened, for every consumer (on logout, say).
   * Consumers see `closed` and do not reconnect; the next `connect()` starts fresh.
   */
  closeAll(code?: number, reason?: string): void;
  /** The URL a descriptor resolves to, without opening anything. */
  urlFor<D extends ChannelDescriptor<any, any, any, any>>(
    descriptor: D,
    options?: ConnectOptions<AddressOf<D>>,
  ): string;
}

/**
 * Create a client holding the connection defaults for a server.
 *
 * For a channel carrying topics, connections are shared per resolved URL: calling
 * `connect` twice with the same descriptor and params yields two independent typed views
 * onto one socket. Plain channels get a socket each unless `share` is set.
 */
export function createClient(options: ClientOptions = {}): ChanxClient {
  const urlFor = <D extends ChannelDescriptor<any, any, any, any>>(
    descriptor: D,
    connectOptions: ConnectOptions<AddressOf<D>> = {},
  ): string =>
    buildUrl(
      options.baseUrl,
      descriptor.address,
      (connectOptions.params ?? {}) as Record<string, string | number>,
      // Merged, so a client-wide token survives a connection adding its own params.
      { ...options.queryParams, ...connectOptions.queryParams },
    );

  const opened = new Set<SharedSocket>();

  return {
    options,
    urlFor,
    closeAll(code = 1000, reason = '') {
      for (const socket of [...opened]) socket.terminate(code, reason);
    },
    connect(descriptor, connectOptions = {}) {
      const socketOptions = {
        ...options,
        ...connectOptions,
        heartbeat: resolveHeartbeat(options, connectOptions, descriptor),
        share: resolveShare(options, connectOptions, descriptor),
      };
      const socket = acquireSocket(urlFor(descriptor, connectOptions), socketOptions);
      if (!opened.has(socket)) {
        opened.add(socket);
        socket.onTerminate(() => opened.delete(socket));
      }
      return new ChannelConnection(
        socket,
        descriptor,
        resolveValidate(options.validate, connectOptions.validate),
      );
    },
  };
}
