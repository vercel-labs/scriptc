// writableLength on http.ServerResponse: the bytes the response holds for
// its socket. A write corks the response until the next tick, so the chunks
// of one tick wait as the one chunk they leave as: the value is their bytes
// plus that chunk's size line and two CRLFs, plus the head until it is
// sent. A fixed-length body counts its own bytes, a response that takes no
// body holds nothing, and bytes the socket has not finished sending still
// count after the uncork.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const log = (tag: string) => console.log(req.url, tag, res.writableLength);
  log("start");
  if (req.url === "/plain") {
    res.write("hello");
    log("after write");
    res.end("bye", () => log("end callback"));
    log("after end");
  } else if (req.url === "/cork") {
    res.cork();
    log("corked");
    res.write("abc");
    log("first corked write");
    res.write("defgh");
    log("second corked write");
    res.uncork();
    log("uncorked");
    res.end();
    log("after end");
  } else if (req.url === "/head") {
    res.writeHead(200, { "content-length": "2" });
    log("after writeHead");
    res.cork();
    res.write("o");
    log("fixed-length corked write");
    res.uncork();
    res.end("k");
    log("after end");
  } else if (req.url === "/flush") {
    res.flushHeaders();
    log("after flushHeaders");
    res.write("0123456789abcdefg");
    log("after write");
    setImmediate(() => {
      log("next turn");
      res.end();
    });
  } else if (req.url === "/long") {
    res.write("x".repeat(300));
    log("after 300-byte write");
    res.end();
  } else if (req.url === "/two") {
    res.write("abc");
    log("first write");
    res.write("defgh");
    log("second write");
    res.write("x".repeat(20));
    log("third write");
    res.end();
    log("after end");
  } else if (req.url === "/cork-flush") {
    res.cork();
    res.flushHeaders();
    log("corked flushHeaders");
    res.write("abc");
    log("corked write");
    res.write("defgh");
    log("second corked write");
    res.uncork();
    log("uncorked");
    res.end();
  } else if (req.url === "/no-body") {
    res.write("abc");
    log("write to a HEAD response");
    res.end("more");
    log("after end");
  } else if (req.url === "/204") {
    res.statusCode = 204;
    res.write("abc");
    log("write to a 204");
    res.end();
    log("after end");
  } else if (req.url === "/304") {
    res.writeHead(304);
    res.write("abc");
    log("write to a 304");
    res.end();
  } else if (req.url === "/large") {
    res.write("x".repeat(8 * 1024 * 1024));
    log("large write");
    res.write("tail");
    log("second write");
    res.on("finish", () => log("finish"));
    res.end("end");
    // The socket cannot take eight megabytes at once: they still count.
    console.log(req.url, "after end", res.writableLength > 8 * 1024 * 1024);
  } else {
    res.setHeader("x-a", "1");
    log("after setHeader");
    res.on("finish", () => log("finish"));
    res.on("close", () => log("close"));
    res.end("some body text");
    log("after end");
  }
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const head = await fetch(`http://127.0.0.1:${port}/no-body`, { method: "HEAD" });
  console.log("/no-body", head.status);
  for (const path of ["/plain", "/cork", "/head", "/flush", "/long", "/two", "/cork-flush", "/204", "/304", "/large", "/other"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    console.log(path, response.status, JSON.stringify((await response.text()).length));
  }
  server.close();
});
