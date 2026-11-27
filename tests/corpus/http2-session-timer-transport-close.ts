// A session's idle timer must not outlive a closed transport: with
// setTimeout armed, a client that disconnects leaves no live session behind
// (the sanitized lane's exit audit is the assertion; Node clears the timer
// at socket close).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("session", (session) => {
  session.setTimeout(60);
  session.on("close", () => lines.push("session close"));
});
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("error", () => {});
  const request = client.request({ ":path": "/" });
  request.on("error", () => {});
  request.resume();
  request.on("end", () => {
    client.destroy();
    setTimeout(() => {
      server.close(() => {
        lines.push("closed");
        for (const line of lines) console.log(line);
      });
    }, 10);
  });
});
