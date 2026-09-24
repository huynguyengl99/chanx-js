/** The slice of AsyncAPI 3 that chanx emits. Deliberately permissive. */

export interface JsonSchema {
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  discriminator?: string | { propertyName?: string };
  [key: string]: unknown;
}

export interface TopicExtension {
  name?: string;
  pattern: string;
  parameters?: string[];
}

export interface ChannelObject {
  address?: string;
  title?: string;
  description?: string;
  messages?: Record<string, { $ref?: string }>;
  parameters?: Record<string, unknown>;
  'x-topic'?: TopicExtension;
}

export interface OperationObject {
  action?: 'send' | 'receive';
  channel?: { $ref?: string };
  messages?: Array<{ $ref?: string }>;
  reply?: { messages?: Array<{ $ref?: string }> };
}

export interface AsyncAPIDocument {
  asyncapi?: string;
  info?: { title?: string; version?: string; description?: string };
  channels?: Record<string, ChannelObject>;
  operations?: Record<string, OperationObject>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    messages?: Record<string, { payload?: JsonSchema }>;
  };
}

export function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

/** Resolve `#/components/messages/x` to the schema name behind its payload. */
export function messageSchemaName(
  document: AsyncAPIDocument,
  ref: string | undefined,
): string | null {
  if (!ref) return null;
  const message = document.components?.messages?.[refName(ref)];
  const payloadRef = message?.payload?.$ref;
  return payloadRef ? refName(payloadRef) : null;
}
