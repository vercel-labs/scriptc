// writableLength on http.ServerResponse: the bytes the response holds for
// its socket. A write corks the message until the next
// tick, so the value counts the head and each chunk with its framing;
// under res.cork() a chunk after the head counts only its own bytes. It is
// zero again once the bytes left.
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
  for (const path of ["/plain", "/cork", "/head", "/flush", "/long", "/other"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    console.log(path, response.status, JSON.stringify((await response.text()).length));
  }
  server.close();
});
