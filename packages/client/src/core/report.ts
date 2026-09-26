/**
 * Surface an error from user code without unwinding the caller.
 *
 * Listeners run in a loop over every consumer of a shared socket, so a throw must not
 * skip the ones after it. This is how `EventTarget` treats a throwing listener: the
 * error reaches `reportError` (the console and `window.onerror` in a browser), or is
 * rethrown on a fresh task where `reportError` does not exist, as in Node.
 */
export function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === 'function') {
    report(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

/** Call a listener, reporting rather than propagating what it throws. */
export function safely<A extends unknown[]>(
  listener: (...args: A) => void,
  ...args: A
): void {
  try {
    listener(...args);
  } catch (error) {
    reportError(error);
  }
}
