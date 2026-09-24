/**
 * The framework-agnostic runtime: client, connections, topics and the wire protocol.
 *
 * @module core
 */
export { createClient } from './core/client';
export type { ChanxClient, ClientOptions, ConnectOptions } from './core/client';

export { ChannelConnection, ChanxRequestError } from './core/connection';
export type { RequestOptions, ValidateConfig } from './core/connection';

export { defineChannel, defineTopic } from './core/descriptor';
export type {
  AddressOf,
  ChannelDescriptor,
  ExtractParams,
  ParamsOf,
  PatternOf,
  ToClientOf,
  ToServerOf,
  TopicDescriptor,
  TopicMap,
  TopicMessage,
  TopicParamsArgs,
  TopicRef,
  TopicRefOf,
  TopicsOf,
  Validator,
  Validators,
} from './core/descriptor';

export type { MessageStream, StreamOptions } from './core/stream';

export { TopicHandle } from './core/topic';
export type { SubscribeOptions, TopicRequestOptions } from './core/topic';

export { terminateAllSockets } from './core/socket';
export type {
  HeartbeatOptions,
  SocketFactory,
  SocketOptions,
  SocketStatus,
  WebSocketLike,
} from './core/socket';

export {
  COMPLETE_ACTIONS,
  ENVELOPE_FIELDS,
  ENVELOPE_VERSION,
  ERROR_ACTION,
  SUBSCRIPTION_ACTIONS,
  formatPattern,
  isFrameworkAction,
  stripEnvelope,
  withEnvelope,
} from './core/protocol';
export type { ChanxErrorFrame, ChanxMessage, Envelope, RawFrame } from './core/protocol';
