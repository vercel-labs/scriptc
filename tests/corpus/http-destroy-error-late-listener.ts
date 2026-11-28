// destroy(error) reports on the message's next tick, so an 'error' listener
// registered right after the call still hears that error before 'close'.
// Node's order: the call returns, then 'error' with the given message, then
// 'close'. Strict ping-pong: one exchange.
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.on("data", () => {});
  req.destroy(new Error("lateboom"));
  // Registered after destroy: the deferred emit still finds it.
  req.on("error", (err: Error) => console.log(`late error: ${err.message}`));
  req.on("close", () => console.log("close"));
  console.log("after destroy");
  res.end("done");
});

server.listen(0, () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const req = request(
    { port: address.port, path: "/late", method: "POST" },
    (res: IncomingMessage) => res.resume()
  );
  req.on("error", () => {});
  req.end("payload");
  setTimeout(() => {
    server.close(() => console.log("closed"));
  }, 150);
});
