import { docComment, propertyKey } from './naming';
import type { JsonSchema } from './schema';
import { refName } from './schema';

const SCALARS: Record<string, string> = {
  string: 'string',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  null: 'null',
};

/**
 * Whether a property is always present on the wire.
 *
 * chanx gives every message's `action` a `const` *and* a default, so Pydantic leaves it
 * out of `required`. Emitting it optional would put `undefined` in the discriminant's
 * domain and break both narrowing and exhaustiveness checks, so a `const` counts as
 * present regardless of `required`.
 */
function isAlwaysPresent(
  name: string,
  property: JsonSchema,
  required: Set<string>,
): boolean {
  return required.has(name) || property.const !== undefined;
}

export function tsType(schema: JsonSchema | undefined, indent = ''): string {
  if (!schema) return 'unknown';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const rendered = [...new Set(variants.map((variant) => tsType(variant, indent)))];
    return rendered.join(' | ');
  }
  if (schema.allOf?.length === 1) return tsType(schema.allOf[0], indent);
  if (schema.allOf?.length) {
    return schema.allOf.map((part) => tsType(part, indent)).join(' & ');
  }

  const suffix = schema.nullable ? ' | null' : '';
  const type = schema.type;

  if (Array.isArray(type)) {
    return type.map((entry) => tsType({ ...schema, type: entry }, indent)).join(' | ');
  }

  if (type === 'array') {
    return `Array<${tsType(schema.items, indent)}>${suffix}`;
  }

  if (type === 'object' || schema.properties) {
    if (schema.properties) return objectBody(schema, indent) + suffix;
    const additional = schema.additionalProperties;
    if (additional && typeof additional === 'object') {
      return `Record<string, ${tsType(additional, indent)}>${suffix}`;
    }
    return `Record<string, unknown>${suffix}`;
  }

  if (typeof type === 'string' && type in SCALARS) {
    return `${SCALARS[type]}${suffix}`;
  }
  return `unknown${suffix}`;
}

function objectBody(schema: JsonSchema, indent: string): string {
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  const lines = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const optional = isAlwaysPresent(name, property, required) ? '' : '?';
    const doc = docComment(property.description, inner);
    return `${doc}${inner}${propertyKey(name)}${optional}: ${tsType(property, inner)};`;
  });
  if (lines.length === 0) return 'Record<string, never>';
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** Emit a named declaration, preferring `interface` for plain object shapes. */
export function declareType(name: string, schema: JsonSchema): string {
  const doc = docComment(schema.description);
  const isPlainObject =
    Boolean(schema.properties) &&
    !schema.anyOf &&
    !schema.oneOf &&
    !schema.allOf &&
    !schema.$ref;

  if (isPlainObject) {
    return `${doc}export interface ${name} ${objectBody(schema, '')}\n`;
  }
  return `${doc}export type ${name} = ${tsType(schema)};\n`;
}

export function emitSchemas(
  schemas: Record<string, JsonSchema>,
  skip: ReadonlySet<string>,
): string {
  return Object.keys(schemas)
    .sort()
    .filter((name) => !skip.has(name))
    .map((name) => declareType(name, schemas[name] as JsonSchema))
    .join('\n');
}
