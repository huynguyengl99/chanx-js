import { createContext, useContext } from 'react';

import type { ChanxClient, ClientOptions } from '../core/client';
import { createClient } from '../core/client';

const ChanxContext = createContext<ChanxClient | null>(null);

export const ChanxClientProvider = ChanxContext.Provider;

// Created eagerly: `createClient` only builds an options holder, it opens nothing.
let fallbackClient: ChanxClient = createClient();

/** Set the client used when no provider is mounted. Handy in tests and small apps. */
export function setDefaultClient(options: ClientOptions | ChanxClient): void {
  fallbackClient = 'connect' in options ? options : createClient(options);
}

export function useChanxClient(): ChanxClient {
  return useContext(ChanxContext) ?? fallbackClient;
}
