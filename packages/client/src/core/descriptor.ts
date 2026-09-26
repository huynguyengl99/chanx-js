import type { ChanxMessage } from './protocol';
import { formatPattern } from './protocol';

/** Names of the `{placeholder}` segments in an address or topic pattern. */
export type ExtractParams<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}` ? P | ExtractParams<Rest> : never;

/** The params object a pattern needs, or an empty object when it has no placeholders. */
export type ParamsOf<S extends string> = [ExtractParams<S>] extends [never]
  ? Record<never, never>
  : { [K in ExtractParams<S>]: string | number };

/**
 * Turns an unknown frame into a validated message, or throws.
 *
 * Supplied by generated code only when codegen ran with `--validation zod`, so the
 * runtime never imports a validation library itself.
 */
export type Validator<T> = (value: unknown) => T;

export interface Validators<ToServer, ToClient> {
  toServer?: Validator<ToServer>;
  toClient?: Validator<ToClient>;
}

/** `with()`'s arguments: params checked against the pattern, optional when it has none. */
export type TopicParamsArgs<Pattern extends string> = [ExtractParams<Pattern>] extends [
  never,
]
  ? [params?: Record<never, never>]
  : [params: ParamsOf<Pattern>];

export interface TopicDescriptor<
  ToServer extends ChanxMessage = ChanxMessage,
  ToClient extends ChanxMessage = ChanxMessage,
  Pattern extends string = string,
> {
  readonly kind: 'topic';
  readonly name: string;
  readonly pattern: Pattern;
  readonly validators?: Validators<ToServer, ToClient>;
  /** Phantom: carries message types through inference, never present at runtime. */
  readonly types?: { toServer: ToServer; toClient: ToClient };
  /**
   * The topic with its params filled in, ready to join:
   * `roomTopic.with({ room_name: 'lobby' })`. A missing or misspelled param is a
   * compile error.
   */
  with(...args: TopicParamsArgs<Pattern>): TopicRef<ToServer, ToClient, Pattern>;
}

/** A topic with its params filled in, from `topic.with(params)`. What gets joined. */
export interface TopicRef<
  ToServer extends ChanxMessage = ChanxMessage,
  ToClient extends ChanxMessage = ChanxMessage,
  Pattern extends string = string,
> {
  readonly descriptor: TopicDescriptor<ToServer, ToClient, Pattern>;
  readonly params: Record<string, string | number>;
  /** The resolved topic string, such as `room:lobby`. */
  readonly topic: string;
}

export type TopicMap = Record<string, TopicDescriptor<any, any, any>>;

export interface ChannelDescriptor<
  ToServer extends ChanxMessage = ChanxMessage,
  ToClient extends ChanxMessage = ChanxMessage,
  Address extends string = string,
  Topics extends TopicMap = TopicMap,
> {
  readonly kind: 'channel';
  readonly name: string;
  readonly address: Address;
  readonly topics: Topics;
  /** The channel answers `ping` with `pong`, so a heartbeat is safe to run on it. */
  readonly heartbeat?: boolean;
  readonly validators?: Validators<ToServer, ToClient>;
  readonly types?: { toServer: ToServer; toClient: ToClient };
}

interface ChannelSpec<Address extends string, Topics extends TopicMap> {
  name: string;
  address: Address;
  topics?: Topics;
  heartbeat?: boolean;
  validators?: Validators<any, any>;
}

interface TopicSpec<Pattern extends string> {
  name: string;
  pattern: Pattern;
  validators?: Validators<any, any>;
}

/**
 * Declare a channel.
 *
 * Curried so the message types can be given explicitly while the address literal and
 * topic map are still inferred: TypeScript has no partial type-argument inference.
 *
 * ```ts
 * export const chat = defineChannel<ChatToServer, ChatToClient>()({
 *   name: 'chat',
 *   address: '/ws/chat/{room}/',
 * });
 * ```
 */
export function defineChannel<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
>() {
  return <const Address extends string, Topics extends TopicMap = Record<never, never>>(
    spec: ChannelSpec<Address, Topics>,
  ): ChannelDescriptor<ToServer, ToClient, Address, Topics> => ({
    kind: 'channel',
    name: spec.name,
    address: spec.address,
    topics: (spec.topics ?? {}) as Topics,
    ...(spec.heartbeat ? { heartbeat: true } : {}),
    ...(spec.validators ? { validators: spec.validators } : {}),
  });
}

/** Declare a topic carried on a channel's connection. Curried for the same reason. */
export function defineTopic<
  ToServer extends ChanxMessage,
  ToClient extends ChanxMessage,
>() {
  // `const`, or a topic defined inline inside `defineChannel` (as codegen writes it)
  // would have its pattern widened to `string`, and `with()` could check nothing.
  return <const Pattern extends string>(
    spec: TopicSpec<Pattern>,
  ): TopicDescriptor<ToServer, ToClient, Pattern> => {
    const descriptor: TopicDescriptor<ToServer, ToClient, Pattern> = {
      kind: 'topic',
      name: spec.name,
      pattern: spec.pattern,
      ...(spec.validators ? { validators: spec.validators } : {}),
      with(...[params = {}]: TopicParamsArgs<Pattern>) {
        const values = params as Record<string, string | number>;
        return { descriptor, params: values, topic: formatPattern(spec.pattern, values) };
      },
    };
    return descriptor;
  };
}

export type ToServerOf<D> =
  D extends ChannelDescriptor<infer TS, any, any, any>
    ? TS
    : D extends TopicDescriptor<infer TS, any, any>
      ? TS
      : D extends TopicRef<infer TS, any, any>
        ? TS
        : never;

export type ToClientOf<D> =
  D extends ChannelDescriptor<any, infer TC, any, any>
    ? TC
    : D extends TopicDescriptor<any, infer TC, any>
      ? TC
      : D extends TopicRef<any, infer TC, any>
        ? TC
        : never;

export type AddressOf<D> =
  D extends ChannelDescriptor<any, any, infer A, any> ? A : never;
export type PatternOf<D> = D extends TopicDescriptor<any, any, infer P> ? P : never;
export type TopicsOf<D> = D extends ChannelDescriptor<any, any, any, infer T> ? T : never;

/** A ref to any of a channel's topics: what that channel's topic APIs accept. */
export type TopicRefOf<D> = {
  [K in keyof TopicsOf<D>]: TopicsOf<D>[K] extends TopicDescriptor<
    infer TS,
    infer TC,
    infer P
  >
    ? TopicRef<TS, TC, P>
    : never;
}[keyof TopicsOf<D>];

/** A message on one of the refs' topics, tagged with its topic and, if sent, its `seq`. */
export type TopicMessage<R> =
  R extends TopicRef<any, infer TC, any> ? TC & { topic: string; seq?: number } : never;
