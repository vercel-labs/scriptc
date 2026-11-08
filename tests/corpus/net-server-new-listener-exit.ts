// A server that is still open when the program exits (unref() lets the
// program end while it listens) drops its 'newListener' list at exit, along
// with its other lists. A 'newListener' handler that captures its own
// server forms a cycle, which the sanitized lane's leak check reports when
// the list outlives the exit.
import * as net from "node:net";

function serve(): void {
  const server = net.createServer((socket: net.Socket) => socket.end("open"));
  const events: string[] = [];
  server.on("newListener", (event: string) => {
    events.push(`${event}:${server.listening}`);
  });
  server.on("connection", () => {});
  server.listen(0, "127.0.0.1", () => {
    console.log("events", events.join(","));
    console.log("listening", server.listening, server.listeners("newListener").length);
    server.unref();
  });
}

serve();
