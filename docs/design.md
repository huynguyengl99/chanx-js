# Design notes

Why chanx-js is built the way it is. For how to use it, see the [guide](./guide/getting-started).

## Scope

This repo is the JavaScript home for [chanx](https://github.com/huynguyengl99/chanx), not only a client: today `@chanx-js/client` (runtime) and `@chanx-js/codegen` (CLI), and a server-side implementation of the same protocol (a NestJS adapter, say) would belong here too.

`core/protocol.ts` is the only file encoding the wire format: envelope v1, the reserved keys, the framework actions and pattern filling. It depends on nothing else and is exported from the package root, so a server package could use it as-is. That file is the natural seam for a shared `chanx-protocol` package, worth extracting once a second consumer exists and not before.

## Why a separate repo from chanx

- **The valuable half is a runtime library**, which needs semver and `npm install`, so it cannot live in a PyPI package. It is the same split as zodios (runtime) and openapi-zod-client (generator).
- **The generator is a TypeScript CLI**, so a frontend project regenerates its client without Python.
- **CI stays separate.** Adding a pnpm workspace and npm publishing to chanx would double its CI surface and tie the npm version to the Python one.

chanx keeps the schema and owns the protocol; this repo is a second implementation of it, held in line by the conformance tests.

## Why not wrap react-use-websocket

Its sharing model (sockets keyed by URL, reference counted) is right, and chanx-js copies it. But:

- It fans messages out through React state setters, so **every subscriber re-renders on every frame**, and a high-rate stream needs hand-rolled batching on top.
- The sharing logic has nothing React-specific in it, yet behind a React dependency it would make the whole core React-only.

So chanx-js takes the design, not the dependency, and adds what that library cannot know about: topics, `ref` request/reply, the envelope, and absorbing chanx's own protocol frames.

## When to share a socket

Sharing is on by default only for channels that carry topics. There, frames are routed per topic and requests matched by `ref`, so consumers stay isolated, and multiplexing is the reason topics exist. A shared plain socket is one inbox, where a reply to one consumer's `send()` reaches all of them: a silent correctness bug, so plain channels get a socket each unless they opt in. It is the same split as Socket.IO, which shares its multiplexed connection, and react-use-websocket, which defaults `share` to `false`. The remaining cost of sharing topics is the second subscriber's initial state; see [State pushed on join](./guide/topics#state-pushed-on-join).

## Errors in user code

Every consumer of a shared socket sees every frame, in one loop. A throwing handler, or a message failing validation, must not skip the consumers after it, so each listener runs isolated and its error goes to `reportError`: the same contract as a throwing DOM event listener. Validation only checks a message and never replaces it with the parser's copy, or a build that validates would deliver different objects from one that does not.

## One controller, four bindings

`createChannelController` holds everything a binding needs (lifecycle, buffering, the `only` filter, `on` dispatch, batching) behind `subscribe` and `getSnapshot`. Each framework binding is then a small adapter: React over `useSyncExternalStore`, Vue over refs, Svelte over a store, Solid over a signal. Behaviour is identical everywhere and tested once, with no framework mounted.

Two framework traps worth remembering:

- **Svelte** must use `writable`, not `readable`: a readable only runs while subscribed, so `get(store)` would report the snapshot from creation. The connection is deliberately eager, so the store mirrors it eagerly too.
- **Solid** needs the `solid` export condition in tests. Otherwise `solid-js` resolves to its server build, where signals are inert and reactivity silently does nothing. The same `browser` condition breaks `ws`, so `vitest.config.ts` gives Solid its own project.

`ts-morph` lives only in `@chanx-js/codegen`: at ~10MB it has no place in the dependencies of a WebSocket client.

## Working with the chanx server

The client relies on these server behaviours. Each was checked against a real chanx server, not only the test fake. The fake deliberately mirrors chanx's limits, because a fake kinder than the server hides client bugs.

- **Replies echo the request's `ref`**: on topic frames always, on plain frames since chanx 2.11.2. Pushes carry none. Every connection on a shared socket sees every frame, so refs are prefixed per connection and a reply with another connection's prefix is ignored.
- **Subscriptions are per socket.** An `unsubscribe` from one consumer would cut off every other consumer of that topic on the socket, so the client counts subscribers on the socket and only unsubscribes when the last one leaves.
- **Disconnecting leaves every topic.** The server runs `on_unsubscribe` for each subscription when a socket closes, so terminating sends no `unsubscribe` frames of its own.
- **A duplicate subscribe does not rerun `on_subscribe`.** A second consumer joining a topic already subscribed on its socket gets no initial state; see [Topics](./guide/topics#state-pushed-on-join).
- **There is no built-in ping handler.** A consumer that declares none answers each ping with an `error` frame, so the heartbeat only runs on channels whose schema declares ping and pong.
- **The `action` constant is not in `required`**, because it also has a default. The generator treats a constant as always present, or the discriminated unions would admit `undefined`.

## Conformance

`conformance/` and `conformance-js/` generate clients from a committed copy of chanx's sandbox schema, as TypeScript and JavaScript output, and compile a consumer of each. `@ts-expect-error` lines assert what must not compile: sending an inbound-only action, omitting an address param, a non-exhaustive `switch`. CI regenerates both and fails on any diff.
