// A plain-JavaScript 'dropRequest' listener: an untyped function's
// parameters (no annotations, no contextual type) are dynamic, and they
// cross into the typed (request, socket) payload like an untyped 'request'
// handler's do. The request past server.maxRequestsPerSocket runs it and is
// answered 503 itself, while the connection stays usable.
import http from "node:http";
import net from "node:net";

const server = http.createServer((req, res) => {
  res.end("hello " + req.url);
});
server.maxRequestsPerSocket = 1;
server.on("dropRequest", (req, socket) => {
  console.log("dropRequest", req.url, req.method, socket.destroyed);
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.write(
      "GET /one HTTP/1.1\r\nHost: example.com\r\n\r\n" +
        "GET /two HTTP/1.1\r\nHost: example.com\r\n\r\n",
    );
  });
  let seen = "";
  client.on("data", (chunk) => (seen += chunk.toString("utf8")));
  client.on("close", () => {
    for (const part of seen.split(/(?=HTTP\/1\.1 )/)) {
      const head = part.split("\r\n\r\n")[0] ?? "";
      console.log(
        head
          .split("\r\n")
          .filter((line) => !line.startsWith("Date: "))
          .join("|"),
      );
    }
    server.close();
  });
  client.on("error", () => {});
});
