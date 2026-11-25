// A chunked response whose writes are still corked when end() runs goes
// out with its terminator in one write, as Node sends it: write() then
// end() in the same tick, a body read from a stream reader, end() with
// data after write(), trailers, and HEAD. An await between write() and
// end() uncorks first, so that response takes two writes. The wire bytes
// are printed here; tests/harness/http-write-end-syscalls.test.ts counts
// the writes per connection under Node and the compiled program.
import * as http from "node:http";
import * as net from "node:net";

async function respond(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader("content-type", "text/plain");
  if (req.url === "/same-tick") {
    res.write("hello");
    res.end();
  } else if (req.url === "/await") {
    res.write("hello");
    await Promise.resolve();
    res.end();
  } else if (req.url === "/reader") {
    const reader = new Response("hello").body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } else if (req.url === "/end-data") {
    res.write("hel");
    res.end("lo");
  } else if (req.url === "/two-writes") {
    res.write("hel");
    res.write("lo");
    res.end();
  } else if (req.url === "/trailers") {
    res.setHeader("trailer", "x-check");
    res.write("hello");
    res.addTrailers({ "x-check": "1" });
    res.end();
  } else {
    res.end("other");
  }
}

const server = http.createServer((req, res) => {
  void respond(req, res);
});

const requests = [
  "GET /same-tick",
  "GET /await",
  "GET /reader",
  "GET /end-data",
  "GET /two-writes",
  "GET /trailers",
  "HEAD /same-tick",
];

function fetchWire(port: number, line: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = "";
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      socket.write(`${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("latin1");
    });
    socket.on("close", () => resolve(data));
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  for (const line of requests) {
    const wire = await fetchWire(port, line);
    console.log(JSON.stringify(line), JSON.stringify(wire.replace(/Date: [^\r]*\r\n/, "")));
    // the server closes its side before the next connection opens
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  server.close();
});
