import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Project } from 'ts-morph';
import { beforeAll, describe, expect, it } from 'vitest';

import { analyze } from '../src/analyze';
import { declareType, tsType } from '../src/emit-types';
import { generate } from '../src/generate';
import { loadSchema } from '../src/loader';
import { camelCase, pascalCase } from '../src/naming';
import type { AsyncAPIDocument } from '../src/schema';

const fixtures = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

describe('naming', () => {
  it('preserves casing inside an already-PascalCase name', () => {
    // A `title()`-style pass would flatten this to `Pingmessage`.
    expect(pascalCase('PingMessage')).toBe('PingMessage');
  });

  it('joins snake_case parts', () => {
    expect(pascalCase('ag_ui_run')).toBe('AgUiRun');
    expect(camelCase('topic_hub')).toBe('topicHub');
  });
});

describe('type emission', () => {
  it('treats a const property as always present', () => {
    // chanx gives `action` a const *and* a default, so Pydantic omits it from
    // `required`. Emitting it optional would admit `undefined` into the
    // discriminant and break exhaustiveness checking.
    const declaration = declareType('PingMessage', {
      type: 'object',
      properties: {
        action: { const: 'ping', default: 'ping', type: 'string' },
        payload: { type: 'null', default: null },
      },
    });
    expect(declaration).toContain('action: "ping";');
    expect(declaration).not.toContain('action?:');
  });

  it('keeps genuinely optional properties optional', () => {
    const declaration = declareType('Thing', {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    });
    expect(declaration).toContain('a: string;');
    expect(declaration).toContain('b?: string;');
  });

  it('renders unions, arrays and refs', () => {
    expect(tsType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(
      'string | null',
    );
    expect(tsType({ type: 'array', items: { $ref: '#/components/schemas/Foo' } })).toBe(
      'Array<Foo>',
    );
  });
});

describe('analysis of the chanx fastapi sandbox', () => {
  let document: AsyncAPIDocument;

  beforeAll(async () => {
    document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
  });

  it('nests topic channels under the connection sharing their address', () => {
    const hub = analyze(document).find((connection) => connection.name === 'topic_hub');
    expect(hub).toBeDefined();
    expect(hub?.address).toBe('/ws/topics');
    expect(hub?.topics.map((topic) => topic.topic?.name).sort()).toEqual([
      'presence_topic',
      'room_topic',
    ]);
  });

  it('promotes a topic channel with no connection at its address', () => {
    // `room_topic` addresses /ws/topics/room/{room_name}, where no plain channel
    // lives, so it owns its own connection.
    const standalone = analyze(document).find(
      (connection) => connection.address === '/ws/topics/room/{room_name}',
    );
    expect(standalone?.topics).toHaveLength(1);
  });

  it('names a hosted topic’s own connection after its host, with no messages', async () => {
    // Shaped like a consumer that declares only a topic: chanx then emits the topic
    // channel alone, named `<host>_<topic>`.
    const hosted: AsyncAPIDocument = {
      asyncapi: '3.0.0',
      channels: {
        agent_thread_topic: {
          address: '/ws/agent',
          title: 'agent_thread_topic',
          'x-topic': { name: 'thread_topic', pattern: 'thread:{id}' },
        },
      },
      operations: {
        run: {
          action: 'receive',
          channel: { $ref: '#/channels/agent_thread_topic' },
          messages: [{ $ref: '#/components/messages/run' }],
        },
      },
      components: {
        messages: { run: { payload: { $ref: '#/components/schemas/RunMessage' } } },
        schemas: {
          RunMessage: { type: 'object', properties: { action: { const: 'run' } } },
        },
      },
    };

    const [agent] = analyze(hosted);
    expect(agent).toMatchObject({ name: 'agent', toServer: [], toClient: [] });
    expect(agent?.topics[0]?.toServer).toEqual(['RunMessage']);

    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    await generate(hosted, { outDir, format: false });
    const channels = await readFile(join(outDir, 'channels.ts'), 'utf-8');
    expect(channels).toContain('export type AgentToServer = never;');
    expect(channels).toContain(
      'export const agent = defineChannel<AgentToServer, AgentToClient>()',
    );
    expect(channels).toContain('threadTopic: defineTopic<AgentThreadTopicToServer');
  });

  it('names directions from the client’s point of view', () => {
    const chat = analyze(document).find((connection) => connection.name === 'chat');
    expect(chat?.toServer).toContain('ChatMessage');
    expect(chat?.toClient).toContain('ChatNotificationMessage');
    expect(chat?.toServer).not.toContain('ChatNotificationMessage');
  });
});

describe('heartbeat detection', () => {
  it('marks a channel that sends ping and receives pong', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const chat = analyze(document).find((connection) => connection.name === 'chat');
    expect(chat?.heartbeat).toBe(true);
  });

  it('leaves a channel without ping unmarked', () => {
    const document: AsyncAPIDocument = {
      channels: { quiet: { title: 'quiet', address: '/ws/quiet' } },
      operations: {
        handle_echo: {
          action: 'receive',
          channel: { $ref: '#/channels/quiet' },
          messages: [{ $ref: '#/components/messages/echo' }],
        },
      },
      components: {
        messages: { echo: { payload: { $ref: '#/components/schemas/Echo' } } },
        schemas: {
          Echo: { type: 'object', properties: { action: { const: 'echo' } } },
        },
      },
    };
    expect(analyze(document)[0]?.heartbeat).toBe(false);
  });

  it('emits heartbeat: true only on channels that declare ping', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    await generate(document, { outDir, format: false });
    const channels = await readFile(join(outDir, 'channels.ts'), 'utf-8');

    const chatBlock = channels.slice(channels.indexOf('export const chat ='));
    expect(chatBlock.slice(0, chatBlock.indexOf('});'))).toContain('heartbeat: true');
  });
});

describe('generate', () => {
  it.each(['fastapi-asyncapi.json', 'django-asyncapi.json'])(
    'produces a full client for %s',
    async (fixture) => {
      const document = await loadSchema(join(fixtures, fixture));
      const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
      const result = await generate(document, { outDir, format: false });

      expect(result.channels).toBeGreaterThan(0);
      expect(result.generatedTypes).toBeGreaterThan(0);

      const channels = await readFile(join(outDir, 'channels.ts'), 'utf-8');
      expect(channels).toContain("from '@chanx-js/client'");
      expect(channels).toContain('export const channels =');

      const schemas = await readFile(join(outDir, 'schemas.ts'), 'utf-8');
      expect(schemas).toContain('export interface PingMessage');
      expect(schemas).toContain('action: "ping";');
    },
  );

  it('emits zod schemas and wires them to validators when asked', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    await generate(document, { outDir, format: false, validation: 'zod' });

    const zod = await readFile(join(outDir, 'schemas.zod.ts'), 'utf-8');
    expect(zod).toContain('export const PingMessageSchema');
    expect(zod).toContain("z.discriminatedUnion('action'");

    const channels = await readFile(join(outDir, 'channels.ts'), 'utf-8');
    expect(channels).toContain('validators:');
    expect(channels).toContain('ChatToServerSchema.parse');
  });

  it('omits validators entirely when validation is off', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    const result = await generate(document, { outDir, format: false });

    expect(result.files.some((file) => file.endsWith('schemas.zod.ts'))).toBe(false);
    const channels = await readFile(join(outDir, 'channels.ts'), 'utf-8');
    expect(channels).not.toContain('validators:');
  });
});

describe('javascript output', () => {
  async function generateJs(extra: Record<string, unknown> = {}) {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-js-'));
    const result = await generate(document, {
      outDir,
      format: false,
      emit: 'js',
      ...extra,
    });
    return { outDir, result };
  }

  it('splits each concern into runtime and declarations', async () => {
    const { outDir, result } = await generateJs();
    const names = result.files.map((file) => file.slice(outDir.length + 1)).sort();

    expect(names).toEqual([
      'channels.d.ts',
      'channels.js',
      'index.d.ts',
      'index.js',
      'schemas.d.ts',
    ]);
  });

  it('emits runtime channels with no TypeScript syntax', async () => {
    const { outDir } = await generateJs();
    const channels = await readFile(join(outDir, 'channels.js'), 'utf-8');

    expect(channels).toContain('export const chat = defineChannel()({');
    // Type arguments and `as const` would both be syntax errors in a .js file.
    expect(channels).not.toContain('defineChannel<');
    expect(channels).not.toContain('as const');
    expect(channels).not.toContain('import type');
  });

  it('declares the descriptors with their full generics', async () => {
    const { outDir } = await generateJs();
    const declaration = await readFile(join(outDir, 'channels.d.ts'), 'utf-8');

    expect(declaration).toContain(
      "import type { ChannelDescriptor, TopicDescriptor } from '@chanx-js/client';",
    );
    expect(declaration).toMatch(/export declare const chat: ChannelDescriptor</);
    // The address literal must survive, or param checking is lost.
    expect(declaration).toContain('"/ws/chat"');
    expect(declaration).toMatch(
      /roomTopic: TopicDescriptor<[\s\S]*?"room:\{room_name\}">/,
    );
  });

  it('keeps the runtime index free of the types-only module', async () => {
    const { outDir } = await generateJs();
    const runtime = await readFile(join(outDir, 'index.js'), 'utf-8');
    const declaration = await readFile(join(outDir, 'index.d.ts'), 'utf-8');

    // `schemas` is declarations only, so importing it at runtime would fail.
    expect(runtime).not.toContain('./schemas');
    expect(runtime).toContain("export * from './channels.js';");
    expect(declaration).toContain("export * from './schemas';");
  });

  it('emits zod as runtime plus declarations, with resolvable specifiers', async () => {
    const { outDir, result } = await generateJs({ validation: 'zod' });
    const names = result.files.map((file) => file.slice(outDir.length + 1));

    expect(names).toContain('schemas.zod.js');
    expect(names).toContain('schemas.zod.d.ts');

    const channels = await readFile(join(outDir, 'channels.js'), 'utf-8');
    // Node's ESM resolution needs the extension on a runtime import.
    expect(channels).toContain("from './schemas.zod.js'");

    const declaration = await readFile(join(outDir, 'schemas.zod.d.ts'), 'utf-8');
    expect(declaration).toContain(
      'export declare const PingMessageSchema: z.ZodType<PingMessage>;',
    );
  });

  it('emits the reuse check as a declaration file', async () => {
    const { outDir, result } = await generateJs({
      reuseStrict: true,
      reuseMap: { PostPayload: '@/types/backend/rooms' },
    });

    expect(result.files.some((file) => file.endsWith('reuse-check.d.ts'))).toBe(true);
    const check = await readFile(join(outDir, 'reuse-check.d.ts'), 'utf-8');
    // Type-level only, so it is valid inside a .d.ts.
    expect(check).toContain('export type CheckPostPayload = Assert<');
    expect(check).not.toContain('= true;');
  });
});

describe('type reuse', () => {
  it('imports an existing type instead of regenerating it', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));

    const result = await generate(document, {
      outDir,
      format: false,
      reuseMap: { PostPayload: '@/types/backend/rooms' },
    });

    expect(result.reusedTypes).toContain('PostPayload');
    const schemas = await readFile(join(outDir, 'schemas.ts'), 'utf-8');
    expect(schemas).toContain(
      "import type { PostPayload } from '@/types/backend/rooms';",
    );
    expect(schemas).not.toContain('export interface PostPayload');
    // Still referenced by the messages that carry it.
    expect(schemas).toContain('PostPayload');
  });

  it('re-exports reused types, so the output compiles under noUnusedLocals', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    // Reusing a message and its payload leaves nothing generated that references
    // either, yet both are imported.
    await generate(document, {
      outDir,
      format: false,
      reuseMap: { PostedMessage: 'backend', PostPayload: 'backend' },
    });

    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { strict: true, noUnusedLocals: true, noEmit: true },
    });
    project.createSourceFile(
      '/schemas.ts',
      await readFile(join(outDir, 'schemas.ts'), 'utf-8'),
    );
    project.createSourceFile(
      '/backend.d.ts',
      "declare module 'backend' { export type PostPayload = { body: string }; export type PostedMessage = { action: 'posted'; payload: PostPayload } }",
    );

    const errors = project.getPreEmitDiagnostics().map((d) => d.getMessageText());
    expect(errors).toEqual([]);
  });

  it('emits assertions that a reused type still matches the schema', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));

    await generate(document, {
      outDir,
      format: false,
      reuseStrict: true,
      reuseMap: { PostPayload: '@/types/backend/rooms' },
    });

    const check = await readFile(join(outDir, 'reuse-check.ts'), 'utf-8');
    expect(check).toContain('MutuallyAssignable<PostPayload, GeneratedPostPayload>');
  });
});

/** Inside the package, so generated code resolves `zod` from its node_modules. */
async function localOutDir(): Promise<string> {
  return mkdtemp(fileURLToPath(new URL('./.generated-', import.meta.url)));
}

describe('zod output with reused types', () => {
  it('imports cleanly and validates when a reused message sits in a union', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await localOutDir();
    try {
      await generate(document, {
        outDir,
        format: false,
        emit: 'js',
        validation: 'zod',
        reuseMap: { PingMessage: '@/types/backend/ping' },
      });
      const zod = (await import(
        pathToFileURL(join(outDir, 'schemas.zod.js')).href
      )) as Record<string, { parse: (value: unknown) => unknown }>;
      const chat = zod.ChatToServerSchema;

      expect(() => chat?.parse({ action: 'ping', payload: null })).not.toThrow();
      expect(() => chat?.parse({ action: 'nope', payload: null })).toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('name clashes', () => {
  const clashing: AsyncAPIDocument = {
    asyncapi: '3.0.0',
    channels: {
      a: { address: '/ws/a', title: 'chat-room' },
      b: { address: '/ws/b', title: 'chat_room' },
    },
  };

  it('refuses to emit two channels that map to one identifier', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    await expect(generate(clashing, { outDir, format: false })).rejects.toThrow(
      /"chatRoom" would be emitted for both channel "a" and channel "b"/,
    );
  });
});

describe('reuse scanning', () => {
  async function scan(
    source: string,
    options: { ambient?: boolean; inOutDir?: boolean },
  ) {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const root = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    const outDir = join(root, 'generated');
    const typesDir = options.inOutDir ? outDir : join(root, 'types');
    await mkdir(typesDir, { recursive: true });
    await writeFile(join(typesDir, 'backend.ts'), source);
    return generate(document, {
      outDir,
      format: false,
      reuseFrom: [join(typesDir, '*.ts')],
      ambient: options.ambient,
    });
  }

  it('reuses an exported type', async () => {
    const result = await scan('export interface PostPayload { body: string }', {});
    expect(result.reusedTypes).toEqual(['PostPayload']);
  });

  it('skips a type that is not exported, since importing it would fail', async () => {
    const result = await scan('interface PostPayload { body: string }', {});
    expect(result.reusedTypes).toEqual([]);
  });

  it('takes every declaration in ambient mode, where nothing is exported', async () => {
    const result = await scan('interface PostPayload { body: string }', {
      ambient: true,
    });
    expect(result.reusedTypes).toEqual(['PostPayload']);
  });

  it('never reuses the previous output as its own source', async () => {
    const result = await scan('export interface PostPayload { body: string }', {
      inOutDir: true,
    });
    expect(result.reusedTypes).toEqual([]);
  });
});

describe('input checks', () => {
  it('rejects an unknown emit target', async () => {
    const document = await loadSchema(join(fixtures, 'fastapi-asyncapi.json'));
    const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    await expect(
      generate(document, { outDir, emit: 'tsx' as 'ts', format: false }),
    ).rejects.toThrow('emit must be "ts" or "js", got "tsx"');
  });

  it('rejects an AsyncAPI 2 document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chanx-codegen-'));
    const path = join(dir, 'schema.json');
    await writeFile(path, JSON.stringify({ asyncapi: '2.6.0', channels: {} }));
    await expect(loadSchema(path)).rejects.toThrow('Expected an AsyncAPI 3 document');
  });
});
