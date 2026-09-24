export interface StreamOptions {
  /**
   * Messages held while the consumer is busy. Once full the oldest is dropped, so a
   * slow `for await` body cannot grow memory without bound.
   */
  limit?: number;
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 1024;

export interface MessageStream<T> extends AsyncIterableIterator<T> {
  /** Stop iterating and release the underlying subscription. */
  close: () => void;
  /** Messages queued because the consumer has not asked for them yet. */
  readonly pending: number;
}

/**
 * Turn a callback subscription into something `for await` can consume.
 *
 * The natural shape for a script: no framework, no handler registration, just a loop
 * that ends when the connection closes or the caller aborts.
 */
export function createMessageStream<T>(
  subscribe: (handler: (message: T) => void) => () => void,
  options: StreamOptions = {},
): MessageStream<T> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const queue: T[] = [];
  const waiting: Array<(result: IteratorResult<T>) => void> = [];
  let finished = false;

  const unsubscribe = subscribe((message) => {
    if (finished) return;
    const next = waiting.shift();
    if (next) {
      next({ value: message, done: false });
      return;
    }
    queue.push(message);
    if (queue.length > limit) queue.shift();
  });

  const close = () => {
    if (finished) return;
    finished = true;
    unsubscribe();
    options.signal?.removeEventListener('abort', close);
    while (waiting.length > 0) {
      waiting.shift()?.({ value: undefined, done: true });
    }
  };

  if (options.signal) {
    if (options.signal.aborted) close();
    else options.signal.addEventListener('abort', close, { once: true });
  }

  const stream: MessageStream<T> = {
    next(): Promise<IteratorResult<T>> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return(): Promise<IteratorResult<T>> {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    close,
    get pending() {
      return queue.length;
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };

  return stream;
}

/**
 * A stream its owner can end, and that leaves `streams` by itself once closed, so a
 * long-lived owner does not collect finished streams.
 */
export function trackStream<T>(
  streams: Set<MessageStream<T>>,
  subscribe: (handler: (message: T) => void) => () => void,
  options: StreamOptions = {},
): MessageStream<T> {
  // Closing can happen during construction (an already-aborted signal), before the
  // stream exists to be removed, hence the holder.
  const entry: { stream?: MessageStream<T>; ended: boolean } = { ended: false };
  const stream = createMessageStream<T>((handler) => {
    const unsubscribe = subscribe(handler);
    return () => {
      entry.ended = true;
      unsubscribe();
      if (entry.stream) streams.delete(entry.stream);
    };
  }, options);
  entry.stream = stream;
  if (!entry.ended) streams.add(stream);
  return stream;
}

/** Resolve with the first message a subscription delivers, or reject on timeout. */
export function firstMessage<T>(
  subscribe: (handler: (message: T) => void) => () => void,
  options: { timeout?: number; signal?: AbortSignal; label?: string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    };

    const onAbort = () => {
      if (settled) return;
      finish();
      reject(new Error(`Aborted while waiting for ${options.label ?? 'a message'}`));
    };

    const unsubscribe = subscribe((message) => {
      if (settled) return;
      finish();
      resolve(message);
    });

    if (options.timeout !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(
          new Error(
            `Timed out after ${options.timeout}ms waiting for ${options.label ?? 'a message'}`,
          ),
        );
      }, options.timeout);
    }

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
