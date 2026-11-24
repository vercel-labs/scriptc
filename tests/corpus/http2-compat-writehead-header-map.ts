// The http2 compatibility response has no wire-only header state: Node's
// writeHead stores its headers in the readable map (setHeader for each), and
// the status it takes becomes a ":status" entry appended after them. A fresh
// response answers an empty map, a header set before writeHead keeps its
// place ahead of the ":status" the writeHead call adds, and a number value
// reads back as a number (":status" included).
import * as http2 from "node:http2";
import * as net from "node:net";

const cases = ["fresh", "set", "set-num", "write", "write-only"];

const server = http2.createServer();
server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  const name = (req.url ?? "/").slice(1);
  if (name === "set") {
    res.setHeader("x-a", "1");
  } else if (name === "set-num") {
    res.setHeader("x-n", 5);
  } else if (name === "write") {
    res.writeHead(201, { "x-a": "1" });
  } else if (name === "write-only") {
    res.writeHead(202);
  }
  console.log(
    name,
    JSON.stringify(res.getHeaders()),
    JSON.stringify(res.getHeader(":status") ?? null),
    JSON.stringify(res.getHeaderNames()),
    res.hasHeader(":status"),
    typeof res.getHeader("x-n"),
    JSON.stringify(res.getHeader("x-n") ?? null),
  );
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const next = (index: number): void => {
    if (index >= cases.length) {
      server.close();
      return;
    }
    const name = cases[index]!;
    const client = http2.connect("http://127.0.0.1:" + port);
    const req = client.request({ ":path": "/" + name });
    req.on("response", (headers) => {
      console.log("wire", name, headers[":status"], JSON.stringify(headers["x-a"] ?? null));
    });
    let body = "";
    req.on("data", (chunk: Uint8Array) => (body += Buffer.from(chunk).toString("utf8")));
    req.on("end", () => {
      console.log("body", name, JSON.stringify(body));
      client.close();
      next(index + 1);
    });
    req.end();
  };
  next(0);
});
