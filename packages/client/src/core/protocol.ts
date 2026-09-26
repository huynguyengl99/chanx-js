/**
 * The chanx wire protocol, mirrored from chanx/constants.py and chanx/core/envelope.py.
 * Generated clients cannot import chanx, so these values are duplicated by design;
 * the conformance tests pin them to the server's own schema.
 */

export const ENVELOPE_VERSION = 1;

/** Reserved frame keys that carry routing rather than message content. */
export const ENVELOPE_FIELDS = ['version', 'topic', 'ref', 'seq'] as const;

/** Frames the runtime absorbs: they signal handling finished, not a message. */
export const COMPLETE_ACTIONS = ['complete', 'event_complete', 'group_complete'] as const;

/** Subscription acks. Answers to a subscribe/unsubscribe request, not a topic's message. */
export const SUBSCRIPTION_ACTIONS = ['subscribed', 'unsubscribed'] as const;

export const ERROR_ACTION = 'error';

const ABSORBED = new Set<string>([
  ...COMPLETE_ACTIONS,
  ...SUBSCRIPTION_ACTIONS,
  ERROR_ACTION,
]);

/** Whether the runtime handles this action itself rather than passing it to user code. */
export function isFrameworkAction(action: string): boolean {
  return ABSORBED.has(action);
}

export interface Envelope {
  version?: number;
  topic?: string;
  ref?: string;
  seq?: number;
}

/** Any chanx message. The discriminant is `action`; `payload` is message-specific. */
export interface ChanxMessage {
  action: string;
}

export type RawFrame = Envelope & Record<string, unknown> & { action?: string };

/** Drop reserved keys so the rest validates as a plain chanx message. */
export function stripEnvelope(frame: RawFrame): ChanxMessage {
  const message: Record<string, unknown> = {};
  for (const key of Object.keys(frame)) {
    if (!(ENVELOPE_FIELDS as readonly string[]).includes(key)) message[key] = frame[key];
  }
  return message as unknown as ChanxMessage;
}

/** The envelope fields a frame carries, for handlers that need `seq` or `ref`. */
export function envelopeOf(frame: RawFrame): Envelope {
  const envelope: Envelope = {};
  for (const key of ENVELOPE_FIELDS) {
    if (frame[key] !== undefined) (envelope as Record<string, unknown>)[key] = frame[key];
  }
  return envelope;
}

export function withEnvelope(
  message: object,
  envelope: { topic?: string; ref?: string },
): Record<string, unknown> {
  // Only the runtime sets envelope keys, so a stray one on the message cannot misroute.
  const frame: Record<string, unknown> = {
    version: ENVELOPE_VERSION,
    ...stripEnvelope(message as RawFrame),
  };
  if (envelope.topic !== undefined) frame.topic = envelope.topic;
  if (envelope.ref !== undefined) frame.ref = envelope.ref;
  return frame;
}

/** An `error` frame from the server, which chanx sends instead of the expected reply. */
export interface ChanxErrorFrame {
  action: typeof ERROR_ACTION;
  payload: unknown;
  topic?: string;
  ref?: string;
}

/**
 * Fill `{name}` placeholders in an address or topic pattern.
 *
 * Pass `encode` for a URL, so a value cannot add path segments or a query. Topic strings
 * are compared verbatim with the server's, so they are filled raw.
 */
export function formatPattern(
  pattern: string,
  params: Record<string, string | number> = {},
  encode: (value: string) => string = (value) => value,
): string {
  return pattern.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing parameter "${name}" for pattern "${pattern}"`);
    }
    return encode(String(value));
  });
}
