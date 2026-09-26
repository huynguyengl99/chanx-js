import type { ChanxMessage, Envelope } from './protocol';
import { safely } from './report';

type Handler<T> = (message: T, envelope: Envelope) => void;

/** Routes messages to handlers registered per `action`, with catch-alls. */
export class ActionEmitter<T extends ChanxMessage> {
  private readonly byAction = new Map<string, Set<Handler<any>>>();
  private readonly anyHandlers = new Set<Handler<T>>();
  private readonly unhandledHandlers = new Set<Handler<T>>();

  on<A extends T['action']>(
    action: A,
    handler: Handler<Extract<T, { action: A }>>,
  ): () => void {
    let handlers = this.byAction.get(action);
    if (!handlers) {
      handlers = new Set();
      this.byAction.set(action, handlers);
    }
    handlers.add(handler as Handler<any>);
    return () => {
      handlers.delete(handler as Handler<any>);
      if (handlers.size === 0) this.byAction.delete(action);
    };
  }

  onAny(handler: Handler<T>): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /** Called for messages no `on(action)` handler claimed. */
  onUnhandled(handler: Handler<T>): () => void {
    this.unhandledHandlers.add(handler);
    return () => this.unhandledHandlers.delete(handler);
  }

  emit(message: T, envelope: Envelope = {}): boolean {
    const handlers = this.byAction.get(message.action);
    if (handlers) for (const handler of [...handlers]) safely(handler, message, envelope);
    for (const handler of [...this.anyHandlers]) safely(handler, message, envelope);

    const claimed = Boolean(handlers?.size) || this.anyHandlers.size > 0;
    if (!claimed) {
      for (const handler of [...this.unhandledHandlers])
        safely(handler, message, envelope);
    }
    return claimed;
  }

  clear(): void {
    this.byAction.clear();
    this.anyHandlers.clear();
    this.unhandledHandlers.clear();
  }
}
