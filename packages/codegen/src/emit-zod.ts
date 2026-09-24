import type { ConnectionInfo } from './analyze';
import { pascalCase, propertyKey } from './naming';
import type { JsonSchema } from './schema';
import { refName } from './schema';

const SCALARS: Record<string, string> = {
  string: 'z.string()',
  integer: 'z.number().int()',
  number: 'z.number()',
  boolean: 'z.boolean()',
  null: 'z.null()',
};

function zodType(schema: JsonSchema | undefined): string {
  if (!schema) return 'z.unknown()';
  // Lazy so declaration order and recursive payloads both work.
  if (schema.$ref) return `z.lazy(() => ${refName(schema.$ref)}Schema)`;
  if (schema.const !== undefined) return `z.literal(${JSON.stringify(schema.const)})`;
  if (schema.enum) {
    const members = schema.enum.map((value) => `z.literal(${JSON.stringify(value)})`);
    return members.length === 1
      ? (members[0] as string)
      : `z.union([${members.join(', ')}])`;
  }

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants?.length) {
    if (variants.length === 1) return zodType(variants[0]);
    return `z.union([${variants.map(zodType).join(', ')}])`;
  }
  if (schema.allOf?.length === 1) return zodType(schema.allOf[0]);
  if (schema.allOf?.length) {
    return schema.allOf
      .map(zodType)
      .reduce((left, right) => `z.intersection(${left}, ${right})`);
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return `z.union([${type.map((entry) => zodType({ ...schema, type: entry })).join(', ')}])`;
  }
  if (type === 'array') return `z.array(${zodType(schema.items)})`;
  if (type === 'object' || schema.properties) {
    if (schema.properties) return zodObject(schema);
    const additional = schema.additionalProperties;
    return typeof additional === 'object'
      ? `z.record(z.string(), ${zodType(additional)})`
      : 'z.record(z.string(), z.unknown())';
  }
  const scalar = typeof type === 'string' ? SCALARS[type] : undefined;
  const base = scalar ?? 'z.unknown()';
  return schema.nullable ? `${base}.nullable()` : base;
}

function zodObject(schema: JsonSchema): string {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    // Same rule as the type emitter: a `const` is always on the wire.
    const present = required.has(name) || property.const !== undefined;
    const value = zodType(property);
    return `  ${propertyKey(name)}: ${present ? value : `${value}.optional()`},`;
  });
  return `z.object({\n${entries.join('\n')}\n})`;
}

/** The `action` constant a message schema pins, if it pins one. */
function actionOf(schema: JsonSchema | undefined): unknown {
  return schema?.properties?.action?.const;
}

export function emitZod(
  schemas: Record<string, JsonSchema>,
  connections: ConnectionInfo[],
  skip: ReadonlySet<string>,
): string {
  const lines: string[] = [`import { z } from 'zod';\n\n`];

  const generated = Object.keys(schemas)
    .sort()
    .filter((name) => !skip.has(name));

  // Reused types are not regenerated, so their validators are permissive by necessity.
  // A reused message still pins its action, which the channel unions discriminate on.
  for (const name of [...skip].sort()) {
    const action = actionOf(schemas[name]);
    const schema =
      action === undefined
        ? 'z.unknown()'
        : `z.object({ action: z.literal(${JSON.stringify(action)}) }).catchall(z.unknown())`;
    lines.push(`export const ${name}Schema = ${schema};\n`);
  }
  if (skip.size) lines.push('\n');

  for (const name of generated) {
    lines.push(`export const ${name}Schema = ${zodType(schemas[name])};\n\n`);
  }

  // Mirrors emit-channels: a self-hosting topic channel is listed twice.
  const declared = new Set<string>();
  for (const connection of connections) {
    for (const channel of [connection, ...connection.topics]) {
      const prefix = pascalCase(channel.name);
      if (declared.has(prefix)) continue;
      declared.add(prefix);
      lines.push(union(`${prefix}ToServerSchema`, channel.toServer, schemas));
      lines.push(union(`${prefix}ToClientSchema`, channel.toClient, schemas));
    }
  }

  return lines.join('');
}

/**
 * The `.d.ts` companion to a JavaScript `schemas.zod.js`.
 *
 * Each validator is declared as `z.ZodType<T>`, which is what `parse` needs to return
 * the right type; reproducing the precise zod class by hand buys nothing.
 */
export function emitZodDeclaration(
  schemas: Record<string, JsonSchema>,
  connections: ConnectionInfo[],
  skip: ReadonlySet<string>,
  schemasModule: string,
  channelsModule: string,
): string {
  const generated = Object.keys(schemas)
    .sort()
    .filter((name) => !skip.has(name));

  const unionNames: string[] = [];
  const declared = new Set<string>();
  for (const connection of connections) {
    for (const channel of [connection, ...connection.topics]) {
      const prefix = pascalCase(channel.name);
      if (declared.has(prefix)) continue;
      declared.add(prefix);
      unionNames.push(`${prefix}ToServer`, `${prefix}ToClient`);
    }
  }

  const lines: string[] = [`import type { z } from 'zod';\n`];
  if (generated.length) {
    lines.push(
      `import type {\n  ${generated.join(',\n  ')},\n} from '${schemasModule}';\n`,
    );
  }
  if (unionNames.length) {
    lines.push(
      `import type {\n  ${unionNames.join(',\n  ')},\n} from '${channelsModule}';\n`,
    );
  }
  lines.push('\n');

  for (const name of [...skip].sort()) {
    lines.push(`export declare const ${name}Schema: z.ZodType<unknown>;\n`);
  }
  for (const name of generated) {
    lines.push(`export declare const ${name}Schema: z.ZodType<${name}>;\n`);
  }
  for (const name of unionNames) {
    lines.push(`export declare const ${name}Schema: z.ZodType<${name}>;\n`);
  }

  return lines.join('');
}

function union(
  name: string,
  members: string[],
  schemas: Record<string, JsonSchema>,
): string {
  if (members.length === 0) return `export const ${name} = z.never();\n`;
  if (members.length === 1) return `export const ${name} = ${members[0]}Schema;\n`;
  const refs = members.map((member) => `${member}Schema`).join(', ');
  // Discriminated on `action`, matching the server's own tagged unions. zod throws at
  // import if a member has no literal action or two share one, so fall back then.
  const actions = members.map((member) => actionOf(schemas[member]));
  const discriminable =
    actions.every((action) => action !== undefined) &&
    new Set(actions).size === actions.length;
  return discriminable
    ? `export const ${name} = z.discriminatedUnion('action', [${refs}]);\n`
    : `export const ${name} = z.union([${refs}]);\n`;
}
