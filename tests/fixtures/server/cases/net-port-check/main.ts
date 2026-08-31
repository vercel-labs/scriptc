/* The findFreePort shape (portless cli-utils): bind an ephemeral port,
 * then try to bind it AGAIN — the second listen must deliver the async
 * 'error' event (EADDRINUSE), never a throw. The message includes the
 * ephemeral port, so only its prefix is compared. */
import { createServer } from "node:net";

const first = createServer();
// Pin both listeners to one IPv4 endpoint. A wildcard first bind can take a
// different address-family path on BSD systems and make the second bind look
// successful even though ordinary same-endpoint listeners must conflict.
first.listen({ port: 0, host: "127.0.0.1" }, () => {
  const port = first.address().port;
  const second = createServer();
  second.on("error", (err) => {
    if (err.message.startsWith("listen EADDRINUSE: address already in use")) {
      console.log("in use");
    } else {
      console.log(`unexpected: ${err.message}`);
    }
    first.close(() => console.log("released"));
  });
  // Explicit false follows the new options ABI but must retain the ordinary
  // single-listener EADDRINUSE behavior.
  second.listen({ port, host: "127.0.0.1", reusePort: false }, () => {
    console.log("bound twice?!");
    // Some BSD kernels accept this SO_REUSEADDR combination. Keep the
    // conflict probe platform-safe even on that path: the first listener
    // must not be left alive while the harness waits for process exit.
    second.close(() => first.close(() => console.log("released")));
  });
});
