import { getGlobalDispatcher, type Dispatcher } from "undici"

/**
 * Node's global fetch keeps Undici's shorter default headers/body timeouts.
 * Wrap the global dispatcher so long-running requests (e.g. image
 * generation) get an explicit cap.
 */
export const createTimeoutDispatcher = (timeoutMs: number): Dispatcher =>
  ({
    dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ) {
      return getGlobalDispatcher().dispatch(
        {
          ...options,
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
        },
        handler,
      )
    },
  }) as Dispatcher
