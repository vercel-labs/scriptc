// IncomingMessage.signal: a stable AbortSignal per message, aborted when the
// message is torn down before it completed (client went away mid-response),
// left alone when the request runs to its end.
import * as http from "node:http";

const server = http.createServer((incoming, outgoing) => {
  const signal = incoming.signal;
  console.log("same signal", signal === incoming.signal, signal.aborted);
  incoming.on("end", () => console.log("request end", signal.aborted));
  if (incoming.url === "/full") {
    signal.addEventListener("abort", () => console.log("unexpected abort"));
    outgoing.end("ok");
    return;
  }
  signal.addEventListener("abort", () => {
    console.log("abort event", signal.aborted, incoming.aborted, incoming.destroyed);
    console.log("reason", (signal.reason as Error).name);
  });
  outgoing.writeHead(200);
  outgoing.write("first");
  incoming.on("close", () => {
    console.log("server close", incoming.aborted, incoming.complete, signal.aborted);
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  const full = http.get({ host: "127.0.0.1", port, path: "/full" }, (response) => {
    response.resume();
    response.on("end", () => {
      console.log("full body", response.statusCode);
      // The long request: the client takes the head of the body and goes
      // away, tearing the server-side message down mid-flight.
      const client = http.request(
        { host: "127.0.0.1", port, path: "/partial" },
        (partial) => {
          partial.on("data", (chunk: Uint8Array) => {
            console.log("body", chunk.byteLength);
            partial.destroy();
          });
          partial.on("error", () => {});
          partial.on("close", () => {
            setTimeout(() => server.close(() => console.log("closed")), 100);
          });
        },
      );
      client.on("error", () => {});
      client.end();
    });
  });
  full.on("error", (error) => console.log("client error", error.message));
});
