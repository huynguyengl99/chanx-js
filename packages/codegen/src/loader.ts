import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { AsyncAPIDocument } from './schema';

/** Load an AsyncAPI document from a URL or a path. JSON and YAML both parse. */
export async function loadSchema(input: string): Promise<AsyncAPIDocument> {
  let text: string;

  if (/^https?:\/\//.test(input)) {
    const response = await fetch(input, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch schema: ${response.status} ${response.statusText}`,
      );
    }
    text = await response.text();
  } else {
    text = await readFile(resolve(input), 'utf-8');
  }

  // YAML is a superset of JSON, so one parser covers both.
  const document = parseYaml(text) as AsyncAPIDocument;
  if (!document || typeof document !== 'object') {
    throw new Error('Schema did not parse to an object');
  }
  if (!document.channels) {
    throw new Error('Schema has no `channels`: is this an AsyncAPI document?');
  }
  if (!String(document.asyncapi ?? '').startsWith('3.')) {
    throw new Error(
      `Expected an AsyncAPI 3 document, got asyncapi: ${String(document.asyncapi ?? 'missing')}`,
    );
  }
  return document;
}
