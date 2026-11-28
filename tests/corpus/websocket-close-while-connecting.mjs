// close() while the server stalls the opening handshake: the pending HTTP
// request is aborted and the socket reports 'error' then close 1006.
import * as net from "node:net";

const server = net.createServer(() => {
  // Accept the connection and never answer the handshake.
});

server.listen(0, () => {
  const ws = new WebSocket("ws://127.0.0.1:" + String(server.address().port) + "/");
  ws.onopen = () => console.log("open");
  ws.onerror = (event) => console.log("error", event.type);
  ws.onclose = (event) => {
    console.log("close", event.code, event.wasClean);
    server.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.log("closing", ws.readyState);
    ws.close(1000);
  }, 30);
});
