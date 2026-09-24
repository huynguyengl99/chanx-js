const SEPARATORS = /[^A-Za-z0-9]+/;

/**
 * PascalCase that preserves casing inside each part.
 *
 * `ag_ui_run` becomes `AgUiRun`, and `PingMessage` stays `PingMessage`. A
 * `title()`-style pass would flatten it to `Pingmessage`.
 */
export function pascalCase(value: string): string {
  return value
    .split(SEPARATORS)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Quote a key only when it is not a valid identifier. */
export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export function docComment(text: string | undefined, indent = ''): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return `${indent}/** ${collapsed.replace(/\*\//g, '*\\/')} */\n`;
}
