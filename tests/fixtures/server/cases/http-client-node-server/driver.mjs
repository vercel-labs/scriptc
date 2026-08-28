// The SERVER side of the pure-client case: binds the port the fixture
// reserved and released (the fixture retries until this is up). Serves
// Content-Length and chunked bodies, then exits on /quit. The driver's
// stdout is compared too — it logs what the CLIENT sent on the wire.
import { createServer } from "node:http";

const port = Number(process.argv[2]);

const server = createServer((req, res) => {
  if (req.url === "/ready") {
    res.end("ok");
    return;
  }
  console.log(`driver saw ${req.method} ${req.url} host=${req.headers.host !== undefined ? "yes" : "no"} conn=${req.headers.connection}`);
  if (req.url === "/text") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain café body");
    return;
  }
  if (req.url === "/chunked") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first ");
    res.write("second ");
    res.end("third");
    return;
  }
  if (req.url === "/reset-content") {
    res.writeHead(205, { "content-length": "4" });
    res.end("body");
    return;
  }
  if (req.url === "/quit") {
    res.end("bye");
    server.close(() => console.log("driver closed"));
    return;
  }
  res.writeHead(404, {});
  res.end();
});

server.listen(port, "127.0.0.1");
