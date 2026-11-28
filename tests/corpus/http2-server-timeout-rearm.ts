// The h2 server's idle timeout: Node emits it on the SERVER (a
// normal-function listener sees the server as `this` and the session as its
// argument), fires it once per session, and a session timer the listener arms
// afterwards reaches only the session's own listeners.
import * as http2 from "node:http2";

let serverTimeouts = 0;
let sessionTimeouts = 0;

const server = http2.createServer();
server.timeout = 100;
server.on("session", (session) => {
  session.on("timeout", () => {
    sessionTimeouts += 1;
  });
});
server.on("timeout", function (this: http2.Http2Server, session) {
  serverTimeouts += 1;
  console.log("server timeout", this === server);
  if (serverTimeouts === 1) session.setTimeout(40);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = http2.connect("http://127.0.0.1:" + port);
  client.on("connect", () => {
    setTimeout(() => {
      console.log("end", serverTimeouts, sessionTimeouts > 0);
      client.close();
      server.close();
    }, 400);
  });
});
