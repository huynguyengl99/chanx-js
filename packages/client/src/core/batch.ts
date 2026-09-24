import type { ChanxMessage } from '../core/protocol';

/** A handler, or a handler that receives frames coalesced over a window. */
export type ActionHandler<M> =
  | ((message: M) => void)
  | {
      /** `'raf'` coalesces per animation frame; a number coalesces per that many ms. */
      batch: 'raf' | number;
      handler: (messages: M[]) => void;
    };

export type HandlerMap<ToClient extends ChanxMessage> = {
  [A in ToClient['action']]?: ActionHandler<Extract<ToClient, { action: A }>>;
};

type Flush = () => void;

/**
 * Coalesces frames so a token stream renders once per frame instead of once per token.
 *
 * React batches updates within a tick, but consecutive frames arrive in separate ticks,
 * so cross-tick coalescing is still needed for a high-rate action.
 */
export class BatchQueue {
  private readonly pending = new Map<string, unknown[]>();
  private readonly timers = new Map<
    string,
    { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly flushAction: (action: string, messages: unknown[]) => void,
  ) {}

  push(action: string, message: unknown, window: 'raf' | number): void {
    const queued = this.pending.get(action);
    if (queued) {
      queued.push(message);
      return;
    }
    this.pending.set(action, [message]);

    const flush: Flush = () => {
      this.timers.delete(action);
      const messages = this.pending.get(action);
      this.pending.delete(action);
      if (messages && messages.length > 0) this.flushAction(action, messages);
    };

    if (window === 'raf' && typeof requestAnimationFrame === 'function') {
      this.timers.set(action, { kind: 'raf', id: requestAnimationFrame(flush) });
    } else {
      const delay = window === 'raf' ? 16 : window;
      this.timers.set(action, { kind: 'timeout', id: setTimeout(flush, delay) });
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      if (timer.kind === 'raf') cancelAnimationFrame(timer.id);
      else clearTimeout(timer.id);
    }
    this.timers.clear();
    this.pending.clear();
  }
}
