/* The findFreePort shape (portless cli-utils): bind an ephemeral port,
 * then try to bind it AGAIN — the second listen must deliver the async
 * 'error' event (EADDRINUSE), never a throw. The message includes the
 * ephemeral port, so only its prefix is compared. */
import { createServer } from "node:net";

const first = createServer();
first.listen(0, () => {
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
    second.close();
  });
});
