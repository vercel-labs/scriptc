// destroy(error) on a server message destroys its socket with that error:
// the server's 'clientError' listeners hear that exact error first, then the
// request's own deferred 'error', then 'close' (Node's ordering). A
// response's destroy(error) reaches the listener the same way, and a
// connection with no 'clientError' listener reports the error only to the
// request's 'error' listeners. Strict ping-pong: one exchange at a time.
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const withListener = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/request") {
    req.on("data", () => {});
    req.on("error", (err: Error) => console.log(`req error: ${err.message}`));
    req.on("close", () => console.log("req close"));
    req.destroy(new Error("reqboom"));
    console.log("req destroy after");
    return;
  }
  res.on("close", () => console.log("res close"));
  res.writeHead(200);
  res.write("partial");
  res.destroy(new Error("resboom"));
  console.log("res destroy after");
});
withListener.on("clientError", (err: Error) => console.log(`clientError: ${err.message}`));

const plain = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.on("data", () => {});
  req.on("error", (err: Error) => console.log(`plain req error: ${err.message}`));
  req.on("close", () => console.log("plain req close"));
  req.destroy(new Error("plainboom"));
  console.log("plain destroy after");
});

const send = (port: number, path: string, done: () => void): void => {
  const req = request({ port, path, method: "POST" }, (res: IncomingMessage) => {
    res.resume();
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.on("close", () => setTimeout(done, 50));
  req.end("payload");
};

withListener.listen(0, () => {
  const withPort = (withListener.address() as { port: number }).port;
  plain.listen(0, () => {
    const plainPort = (plain.address() as { port: number }).port;
    send(withPort, "/request", () => {
      send(withPort, "/response", () => {
        send(plainPort, "/plain", () => {
          withListener.close();
          plain.close(() => console.log("closed"));
        });
      });
    });
  });
});
