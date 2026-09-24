---
layout: home

hero:
  name: chanx-js
  text: Typed WebSocket clients for chanx
  tagline: Generate a client from your chanx AsyncAPI schema, then use it from React, Vue, Svelte, Solid or plain JavaScript, topics included.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /api/
    - theme: alt
      text: GitHub
      link: https://github.com/huynguyengl99/chanx-js

features:
  - title: Typed from the schema
    details: '@chanx-js/codegen turns the AsyncAPI document chanx already serves into typed channel descriptors. Sending an inbound-only action, or forgetting an address param, is a compile error.'
  - title: Topics over one socket
    details: 'Subscribe to many topics over a single connection. Subscriptions are reference counted, requests are matched by ref, and everything resubscribes after a reconnect.'
  - title: Sharing done right
    details: 'Components on a topic channel share one socket, and one leaving never unsubscribes or cuts off another. Plain channels stay separate unless you opt in, so replies never leak between components.'
  - title: Every framework, one behaviour
    details: 'React, Vue, Svelte and Solid bindings are thin adapters over one shared controller, so buffering and batching behave identically everywhere.'
  - title: Plain JavaScript and Node
    details: 'No framework required. Await a connection, await one message, or iterate with for await. Node 22 works out of the box.'
  - title: Zero runtime dependencies
    details: 'The runtime ships no dependencies. Validation with zod is opt-in and only loaded when you ask for it; types-only builds carry none of it.'
---
