// A server that answers the upgrade with a 500 and then leaves the body
// unfinished: the failed handshake reports error/close and the connection is
// torn down, so the server sees its side close too.
import * as http from "node:http";

let serverClosed = false;
let clientClosed = false;
let finished = false;

const server = http.createServer((_req, res) => {
  res.writeHead(500, { "content-length": "1000" });
  res.write("partial");
  // never sends the rest and never ends the response
});

function finish() {
  if (finished || !serverClosed || !clientClosed) return;
  finished = true;
  console.log("both sides closed");
  server.close();
  process.exit(0);
}

server.on("connection", (socket) => {
  socket.on("close", () => {
    serverClosed = true;
    finish();
  });
});

server.listen(0, "127.0.0.1", () => {
  const ws = new WebSocket("ws://127.0.0.1:" + String(server.address().port) + "/rejected");
  ws.onerror = (event) => console.log("error", event.type);
  ws.onclose = (event) => {
    console.log("close", event.code, event.wasClean);
    clientClosed = true;
    finish();
  };
  setTimeout(() => {
    if (finished) return;
    console.log("timeout", serverClosed, clientClosed);
    server.close();
    process.exit(0);
  }, 500);
});
