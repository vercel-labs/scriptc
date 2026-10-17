// 'data' listeners on IncomingMessage (server and client side) and on a
// net.Socket receive Buffers in Node, so string coercion of a chunk
// (`body += chunk`, template interpolation, String(chunk)) decodes utf8.
// A plain Uint8Array would join its elements instead ("104,105").
import { createServer, request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk;
  });
  req.on("end", () => {
    console.log(`srv body=${body}`);
    res.end(`echo:${body}`);
  });
});

function netRound(done: () => void): void {
  const ns = createNetServer((sock) => {
    sock.on("data", (chunk: Buffer) => {
      console.log(`net srv ${String(chunk)}`);
      sock.end("pong");
    });
  });
  ns.listen(0, "127.0.0.1", () => {
    const c = connect(ns.address().port, "127.0.0.1", () => {
      c.write("ping");
    });
    let got = "";
    c.on("data", (chunk: Buffer) => {
      got = `${got}${chunk}`;
    });
    c.on("end", () => {
      console.log(`net cli ${got}`);
      ns.close();
      done();
    });
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = request({ hostname: "127.0.0.1", port, method: "POST", path: "/", agent: false }, (res) => {
    let text = "";
    res.on("data", (chunk: Buffer) => {
      text += chunk;
    });
    res.on("end", () => {
      console.log(`cli body=${text}`);
      server.close();
      netRound(() => console.log("done"));
    });
  });
  req.end("héllo");
});
