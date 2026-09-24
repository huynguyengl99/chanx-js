import type { ChannelInfo, ConnectionInfo } from './analyze';
import { camelCase, docComment, pascalCase, propertyKey } from './naming';

export interface ChannelEmitOptions {
  withZod: boolean;
  schemasModule: string;
  zodModule: string;
  /** `ts` emits one typed module; `js` splits runtime and declarations. */
  target: 'ts' | 'js';
}

function unionType(name: string, members: string[]): string {
  return `export type ${name} = ${members.length ? members.join(' | ') : 'never'};\n`;
}

function validatorsLiteral(prefix: string, indent: string): string {
  return (
    `${indent}validators: {\n` +
    `${indent}  toServer: (value) => ${prefix}ToServerSchema.parse(value),\n` +
    `${indent}  toClient: (value) => ${prefix}ToClientSchema.parse(value),\n` +
    `${indent}},\n`
  );
}

/** Type arguments are erased in JS, so the runtime file calls the plain form. */
function typeArgs(prefix: string, target: 'ts' | 'js'): string {
  return target === 'ts' ? `<${prefix}ToServer, ${prefix}ToClient>` : '';
}

function renderTopic(
  topic: ChannelInfo,
  options: ChannelEmitOptions,
  indent: string,
): string {
  const prefix = pascalCase(topic.name);
  const key = camelCase(topic.topic?.name ?? topic.name);
  const inner = `${indent}  `;
  return (
    docComment(topic.description, indent) +
    `${indent}${propertyKey(key)}: defineTopic${typeArgs(prefix, options.target)}()({\n` +
    `${inner}name: ${JSON.stringify(topic.topic?.name ?? topic.name)},\n` +
    `${inner}pattern: ${JSON.stringify(topic.topic?.pattern ?? '')},\n` +
    (options.withZod ? validatorsLiteral(prefix, inner) : '') +
    `${indent}}),\n`
  );
}

function collectPrefixes(connection: ConnectionInfo): string[] {
  return [connection, ...connection.topics].map((channel) => pascalCase(channel.name));
}

function zodImport(connections: ConnectionInfo[], zodModule: string): string {
  const names = [...new Set(connections.flatMap(collectPrefixes))]
    .sort()
    .flatMap((prefix) => [`${prefix}ToServerSchema`, `${prefix}ToClientSchema`]);
  return `import {\n  ${names.join(',\n  ')},\n} from '${zodModule}';\n`;
}

/** Declare each channel's message unions exactly once. */
function unions(connections: ConnectionInfo[]): string {
  const lines: string[] = [];
  // A topic channel with no plain channel at its address is its own connection, so it
  // appears in both lists and must only be declared once.
  const declared = new Set<string>();
  for (const connection of connections) {
    for (const channel of [connection, ...connection.topics]) {
      const prefix = pascalCase(channel.name);
      if (declared.has(prefix)) continue;
      declared.add(prefix);
      lines.push(unionType(`${prefix}ToServer`, channel.toServer));
      lines.push(unionType(`${prefix}ToClient`, channel.toClient));
    }
    lines.push('\n');
  }
  return lines.join('');
}

/** The descriptor values. Valid TypeScript or JavaScript depending on `target`. */
export function emitChannels(
  connections: ConnectionInfo[],
  messageNames: string[],
  options: ChannelEmitOptions,
): string {
  const lines: string[] = [
    `import { defineChannel, defineTopic } from '@chanx-js/client';\n\n`,
  ];

  if (options.target === 'ts') {
    if (messageNames.length) {
      const imported = [...messageNames].sort().join(',\n  ');
      lines.push(`import type {\n  ${imported},\n} from '${options.schemasModule}';\n`);
    }
  }
  if (options.withZod) lines.push(zodImport(connections, options.zodModule));
  lines.push('\n');

  if (options.target === 'ts') lines.push(unions(connections));

  for (const connection of connections) {
    const prefix = pascalCase(connection.name);
    const constName = camelCase(connection.name);

    lines.push(docComment(connection.description));
    lines.push(
      `export const ${constName} = defineChannel${typeArgs(prefix, options.target)}()({\n`,
    );
    lines.push(`  name: ${JSON.stringify(connection.name)},\n`);
    lines.push(`  address: ${JSON.stringify(connection.address)},\n`);
    if (connection.heartbeat) lines.push('  heartbeat: true,\n');
    if (options.withZod) lines.push(validatorsLiteral(prefix, '  '));
    if (connection.topics.length) {
      lines.push('  topics: {\n');
      for (const topic of connection.topics) {
        lines.push(renderTopic(topic, options, '    '));
      }
      lines.push('  },\n');
    }
    lines.push('});\n\n');
  }

  const registry = connections
    .map((connection) => `  ${propertyKey(camelCase(connection.name))}`)
    .join(',\n');
  const asConst = options.target === 'ts' ? ' as const' : '';
  lines.push(`export const channels = {\n${registry},\n}${asConst};\n`);

  return lines.join('');
}

/**
 * The `.d.ts` companion to a JavaScript `channels.js`.
 *
 * Declares the same descriptors with their full generic arguments, so a plain-JS project
 * still gets narrowing, address-param checking and topic typing from its editor.
 */
export function emitChannelsDeclaration(
  connections: ConnectionInfo[],
  messageNames: string[],
  options: ChannelEmitOptions,
): string {
  const lines: string[] = [
    `import type { ChannelDescriptor, TopicDescriptor } from '@chanx-js/client';\n`,
  ];

  if (messageNames.length) {
    const imported = [...messageNames].sort().join(',\n  ');
    lines.push(`import type {\n  ${imported},\n} from '${options.schemasModule}';\n`);
  }
  lines.push('\n');
  lines.push(unions(connections));

  for (const connection of connections) {
    const prefix = pascalCase(connection.name);
    const constName = camelCase(connection.name);
    const address = JSON.stringify(connection.address);

    const topics = connection.topics
      .map((topic) => {
        const topicPrefix = pascalCase(topic.name);
        const key = camelCase(topic.topic?.name ?? topic.name);
        const pattern = JSON.stringify(topic.topic?.pattern ?? '');
        return `  ${propertyKey(key)}: TopicDescriptor<${topicPrefix}ToServer, ${topicPrefix}ToClient, ${pattern}>;`;
      })
      .join('\n');

    const topicsType = connection.topics.length
      ? `{\n${topics}\n}`
      : 'Record<never, never>';

    lines.push(docComment(connection.description));
    lines.push(
      `export declare const ${constName}: ChannelDescriptor<${prefix}ToServer, ${prefix}ToClient, ${address}, ${topicsType}>;\n\n`,
    );
  }

  const registry = connections
    .map((connection) => {
      const constName = camelCase(connection.name);
      return `  ${propertyKey(constName)}: typeof ${constName};`;
    })
    .join('\n');
  lines.push(`export declare const channels: {\n${registry}\n};\n`);

  return lines.join('');
}
