/* writeHead stores the head: the first write(), end() or flushHeaders()
 * sends it, and an Expect header sends it at once (Node's _storeHeader).
 * A cork()/uncork() pair with no write between keeps it stored; a write or
 * flushHeaders() while corked sends it at the uncork.
 * The driver reads the raw wire and reports whether any bytes arrived
 * before the delayed body. */
import { createServer } from "node:http";

const server = createServer((req, res) => {
  const url = req.url;
  if (url === "/hold") {
    res.writeHead(200, { "content-type": "text/plain" });
    console.log(`hold headersSent=${res.headersSent}`);
    setTimeout(() => {
      res.write("late ");
      res.end("body");
    }, 300);
  } else if (url === "/flush") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.flushHeaders();
    setTimeout(() => {
      res.end("flushed");
    }, 300);
  } else if (url === "/expect") {
    res.setHeader("expect", "100-continue");
    res.writeHead(200, { "content-type": "text/plain" });
    setTimeout(() => {
      res.end("expected");
    }, 300);
  } else if (url === "/cork") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.cork();
    res.uncork();
    setTimeout(() => {
      res.end("corked");
    }, 300);
  } else if (url === "/cork-flush") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.cork();
    res.flushHeaders();
    res.uncork();
    setTimeout(() => {
      res.end("corked flush");
    }, 300);
  } else if (url === "/cork-write") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.cork();
    res.write("");
    res.uncork();
    setTimeout(() => {
      res.end("corked write");
    }, 300);
  } else if (url === "/length") {
    res.writeHead(200, { "content-length": "5" });
    res.end("fixed");
  } else {
    res.writeHead(204);
    res.end();
    server.close(() => console.log("server closed"));
  }
});

server.listen(0, () => {
  console.log("listening");
  process.stderr.write(`PORT ${server.address().port}\n`);
});
