// @requires-libnode
// A node:http.Server and a node:net.Server an island made cross the
// boundary as values native code uses: the declared types map to native
// server handles, but the listening sockets live in the island, so the
// handle is the value and address(), close(), listening and the events
// dispatch through it.
import { httpServer, netServer } from "server-pkg";

const http = httpServer((_req, res) => {
  res.end("ok");
});

console.log("http before", http.listening, http.address());
http.on("listening", () => {
  console.log("http listening event");
});
http.on("close", () => {
  console.log("http close event");
});
http.listen(0, () => {
  const addr = http.address();
  const bound = typeof addr === "object" && addr !== null;
  console.log("http listening", http.listening, bound, bound ? addr.port > 0 : false);
  http.close(() => {
    console.log("http closed", http.listening);
    netPhase();
  });
});

// Started once the http server is gone, so the run order does not depend on
// which socket binds first.
function netPhase(): void {
  const net = netServer((socket) => {
    socket.end("hi");
  });
  console.log("net before", net.listening, net.address());
  net.on("listening", () => {
    const addr = net.address();
    console.log(
      "net listening event",
      net.listening,
      typeof addr === "object" && addr !== null,
    );
  });
  net.listen(0, () => {
    const addr = net.address();
    console.log("net listening", net.listening, typeof addr === "object" && addr !== null);
    net.close(() => {
      console.log("net closed", net.listening);
    });
  });
}
