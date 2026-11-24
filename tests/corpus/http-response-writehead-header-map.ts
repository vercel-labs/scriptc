// writeHead(status, headers) without a header in the map beforehand writes
// those headers to the wire but keeps them out of the readable header map,
// as Node's kOutHeaders does; a setHeader/appendHeader before writeHead
// creates the map, so the writeHead headers merge into it and the getters
// answer them. writeHead's array-of-pairs form and array values follow the
// same rule, and a setHeader after writeHead throws ERR_HTTP_HEADERS_SENT
// with the map still empty.
import * as http from "node:http";
import * as net from "node:net";

const cases = [
  "bare",
  "set-then-write",
  "append-then-write",
  "status-msg-headers",
  "status-only",
  "array-value",
  "pairs-array-form",
  "set-after-bare",
];

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const name = (req.url ?? "/").slice(1);
  const out: string[] = [];
  if (name === "bare") {
    res.writeHead(200, { "x-a": "1" });
  } else if (name === "set-then-write") {
    res.setHeader("x-b", "2");
    res.writeHead(200, { "x-a": "1" });
  } else if (name === "append-then-write") {
    res.appendHeader("x-b", "2");
    res.writeHead(200, { "x-a": "1" });
  } else if (name === "status-msg-headers") {
    res.writeHead(201, "Made", { "x-a": "1" });
  } else if (name === "array-value") {
    res.writeHead(200, { "x-a": ["1", "2"] });
  } else if (name === "pairs-array-form") {
    res.writeHead(200, ["x-a", "1"]);
  } else if (name === "set-after-bare") {
    res.writeHead(200, { "x-a": "1" });
    try {
      res.setHeader("x-c", "3");
      out.push("set ok");
    } catch (e) {
      out.push("set throw " + (e as NodeJS.ErrnoException).code);
    }
  } else {
    res.writeHead(200);
  }
  out.push(
    JSON.stringify(res.getHeaders()),
    JSON.stringify(res.getHeader("x-a") ?? null),
    JSON.stringify(res.getHeaderNames()),
    String(res.hasHeader("x-a")),
  );
  console.log(name, out.join(" | "));
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
    http.get({ host: "127.0.0.1", port, path: "/" + name }, (res: http.IncomingMessage) => {
      console.log("wire", name, JSON.stringify(res.headers["x-a"] ?? null));
      res.resume();
      res.on("end", () => next(index + 1));
    });
  };
  next(0);
});
