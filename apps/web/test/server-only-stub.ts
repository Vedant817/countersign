/**
 * A Vitest stand-in for the `server-only` marker.
 *
 * Next replaces `server-only` with an empty module in the server graph. Vitest does not run Next's
 * bundler, so importing a route handler that (correctly) imports `server-only` would throw before a
 * single assertion. The marker's job is to stop a *client* bundle from importing server code; a Node
 * test runner is not a client bundle, so the empty module is the faithful equivalent.
 */
export {}
