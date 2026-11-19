// A Transfer-Encoding array advertises each token on its own line; when any
// element is "chunked" the body is framed as chunks, as Node does.
import net from "node:net";
import { request } from "node:http";

const server = net.createServer((socket) => {
  let raw = "";
  socket.on("data", (chunk) => {
    raw += chunk.toString("latin1");
    if (raw.includes("0\r\n\r\n")) {
      const head = raw.replace(/Host: [^\r]*/, "Host: host");
      console.log(JSON.stringify(head));
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = request({ host: "127.0.0.1", port, path: "/", method: "POST", agent: false });
  req.setHeader("Transfer-Encoding", ["gzip", "chunked"]);
  req.write("abc");
  req.end();
  req.on("error", () => {});
  req.on("close", () => server.close(() => console.log("closed")));
});
