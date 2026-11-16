import "server-only";
import { Agent, type Dispatcher } from "undici";

// Fetch supplies its own 300s defaults to dispatch(), so Agent options alone
// do not remove the deadline. Override at the documented Dispatcher boundary.
class PelicanDispatcher extends Agent {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
    return super.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
  }
}
const key = Symbol.for("promptmaster.pelican.dispatcher");
const state = globalThis as typeof globalThis & { [key]?: PelicanDispatcher };
export function pelicanFetch(url: string | URL | Request, init?: RequestInit) {
  const dispatcher = (state[key] ??= new PelicanDispatcher());
  // Keep the shared fetch boundary injectable by isolated integration suites.
  return fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher });
}
