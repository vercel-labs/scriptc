// An 'abort' listener on a message's signal that captures the message: the
// listener runs when the client goes away mid-body, and the message that
// settles at 'close' drops the signal's listeners. Nothing here reads the
// signal afterwards, so the program's output is the same either way; the
// sanitized lane's LeakSanitizer run (tests/harness/http-message-signal-
// leaks.test.ts) is what pins the ownership, and this program is its
// input on every flavor.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((incoming, outgoing) => {
  const signal = incoming.signal;
  signal.addEventListener("abort", () => {
    console.log("abort", signal.aborted, incoming.aborted, incoming.destroyed);
    console.log("reason", (signal.reason as Error).name);
  });
  outgoing.writeHead(200);
  outgoing.write("first");
  incoming.on("close", () => {
    console.log("close", incoming.aborted, incoming.complete, signal.aborted);
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const client = net.connect(port, "127.0.0.1", () => {
    client.write("GET / HTTP/1.1\r\nHost: h\r\n\r\n");
  });
  // Take the head of the body and go away: the server-side message is torn
  // down incomplete, so its signal aborts exactly once.
  client.on("data", () => {
    client.destroy();
    setTimeout(() => server.close(() => console.log("closed")), 50);
  });
});
